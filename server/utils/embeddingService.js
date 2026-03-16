const { OpenAIEmbeddings } = require('@langchain/openai');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Tiktoken } = require('js-tiktoken/lite');
const cl100k_base = require('js-tiktoken/ranks/cl100k_base');

// Initialize Pinecone client
let pineconeClient = null;
let pineconeIndex = null;

/**
 * Initialize Pinecone client and index
 */
async function initializePinecone() {
  if (!process.env.PINECONE_API_KEY) {
    throw new Error('PINECONE_API_KEY is not set in environment variables');
  }
  
  if (!process.env.PINECONE_INDEX_NAME) {
    throw new Error('PINECONE_INDEX_NAME is not set in environment variables');
  }

  if (!pineconeClient) {
    pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });
    
    const indexName = process.env.PINECONE_INDEX_NAME;
    
    // Check if index exists, create if it doesn't
    try {
      const indexList = await pineconeClient.listIndexes();
      const indexExists = indexList.indexes?.some(idx => idx.name === indexName);
      
      if (!indexExists) {
        console.log(`Index '${indexName}' not found. Creating new index...`);
        
        // Get dimension for text-embedding-3-large (3072 dimensions)
        const dimension = 3072;
        
        // Create the index
        await pineconeClient.createIndex({
          name: indexName,
          dimension: dimension,
          metric: 'cosine',
          spec: {
            serverless: {
              cloud: 'aws',
              region: process.env.PINECONE_REGION || 'us-east-1'
            }
          }
        });
        
        console.log(`Index '${indexName}' created successfully. Waiting for it to be ready...`);
        
        // Wait for index to be ready (can take a few seconds)
        let ready = false;
        let attempts = 0;
        while (!ready && attempts < 30) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const indexes = await pineconeClient.listIndexes();
          const index = indexes.indexes?.find(idx => idx.name === indexName);
          if (index && index.status?.ready) {
            ready = true;
          }
          attempts++;
        }
        
        if (!ready) {
          throw new Error(`Index '${indexName}' was created but is not ready yet. Please wait a moment and try again.`);
        }
        
        console.log(`Index '${indexName}' is ready!`);
      }
    } catch (error) {
      // If listing indexes fails, try to create anyway (might be permission issue)
      if (error.message.includes('404') || error.message.includes('not found')) {
        console.log('Could not check index existence. Attempting to use index directly...');
      } else {
        console.error('Error checking/creating index:', error.message);
        // Continue anyway - the index might exist but we can't list it
      }
    }
    
    pineconeIndex = pineconeClient.index(indexName);
  }

  return pineconeIndex;
}

// Batch size for embedding + upsert (avoids rate limits and request size limits for large files)
const EMBED_BATCH_SIZE = 100;

// text-embedding-3-large max is 8192; use slightly less to account for API/tokenizer variance
const MAX_EMBED_TOKENS = 8180;

let _embeddingEncoder = null;
function getEmbeddingEncoder() {
  if (!_embeddingEncoder) _embeddingEncoder = new Tiktoken(cl100k_base);
  return _embeddingEncoder;
}

/**
 * Truncate text to fit within the embedding model's token limit (8192 tokens).
 * Uses cl100k_base tokenizer (same as text-embedding-3-large).
 * @param {string} text
 * @returns {string}
 */
function truncateForEmbedding(text) {
  if (!text || typeof text !== 'string') return '';
  const enc = getEmbeddingEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= MAX_EMBED_TOKENS) return text;
  const truncated = enc.decode(tokens.slice(0, MAX_EMBED_TOKENS));
  return truncated + ' [truncated]';
}

/**
 * Create embeddings and store them in Pinecone (in batches for large doc sets).
 * @param {Array} docs - Array of document chunks
 * @param {string} sourceName - Name/source identifier for the documents
 * @returns {Promise<void>}
 */
async function embedAndStore(docs, sourceName) {
  try {
    // Initialize Pinecone if not already done
    const index = await initializePinecone();

    // Initialize OpenAI embeddings with text-embedding-3-large model
    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: 'text-embedding-3-large',
    });

    const uploadTimestamp = Date.now();
    let totalStored = 0;

    const totalBatches = Math.ceil(docs.length / EMBED_BATCH_SIZE);
    for (let offset = 0; offset < docs.length; offset += EMBED_BATCH_SIZE) {
      const batchNum = Math.floor(offset / EMBED_BATCH_SIZE) + 1;
      console.log(`  Processing batch ${batchNum}/${totalBatches} (chunks ${offset + 1}-${Math.min(offset + EMBED_BATCH_SIZE, docs.length)} of ${docs.length})...`);

      const batch = docs.slice(offset, offset + EMBED_BATCH_SIZE);
      const texts = batch.map(doc => truncateForEmbedding(doc.pageContent || doc));
      const vectors = await embeddings.embedDocuments(texts);

      const vectorsToUpsert = vectors.map((embedding, idx) => {
        const doc = batch[idx];
        const globalIdx = offset + idx;
        const chunkId = `${sourceName}_chunk_${globalIdx}_${uploadTimestamp}`;
        const storedText = truncateForEmbedding(doc.pageContent || doc);
        return {
          id: chunkId,
          values: embedding,
          metadata: {
            source: sourceName,
            chunk_id: chunkId,
            text: storedText,
            upload_timestamp: uploadTimestamp,
          },
        };
      });

      await index.upsert(vectorsToUpsert);
      totalStored += vectorsToUpsert.length;
      console.log(`  Stored batch ${batchNum}/${totalBatches}: ${totalStored}/${docs.length} chunks`);
      // Small delay between batches to reduce rate-limit risk
      if (offset + EMBED_BATCH_SIZE < docs.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    console.log(`Successfully embedded and stored ${totalStored} chunks from ${sourceName}`);
  } catch (error) {
    console.error('Error in embedAndStore:', error);
    throw new Error(`Failed to embed and store documents: ${error.message}`);
  }
}

/**
 * Search for similar vectors in Pinecone
 * Prioritizes recent uploads by fetching more results and sorting by timestamp
 * @param {string} query - Query text to search for
 * @param {number} topK - Number of top results to return (default: 3)
 * @returns {Promise<Array>} - Array of similar documents with metadata
 */
async function searchSimilar(query, topK = 3) {
  try {
    // Initialize Pinecone if not already done
    const index = await initializePinecone();

    // Initialize OpenAI embeddings
    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: 'text-embedding-3-large',
    });

    // Generate embedding for the query
    const queryEmbedding = await embeddings.embedQuery(query);

    // Fetch significantly more results (topK * 5) to ensure we capture new uploads
    // This is critical because new uploads might have lower semantic similarity scores
    // but should still be prioritized over old data
    const fetchCount = Math.max(topK * 5, 20);
    
    // Query Pinecone for similar vectors
    const queryResponse = await index.query({
      vector: queryEmbedding,
      topK: fetchCount,
      includeMetadata: true,
    });

    // Extract matches with metadata
    const allResults = queryResponse.matches.map(match => ({
      score: match.score,
      text: match.metadata?.text || '',
      source: match.metadata?.source || '',
      chunkId: match.metadata?.chunk_id || match.id,
      uploadTimestamp: match.metadata?.upload_timestamp || 0,
    }));

    // Prioritize by RELEVANCE (score) so FAQ/product chunks can win over newer ticket chunks.
    // When FAQs and tickets are both ingested, "Vipps" / "tekstilprøver" should match FAQ chunks.
    allResults.sort((a, b) => {
      const scoreA = typeof a.score === 'number' ? a.score : 0;
      const scoreB = typeof b.score === 'number' ? b.score : 0;
      return scoreB - scoreA; // Higher score first
    });

    const finalResults = allResults.slice(0, topK).map(({ uploadTimestamp, ...rest }) => rest);

    return finalResults;
  } catch (error) {
    console.error('Error in searchSimilar:', error);
    throw new Error(`Failed to search similar documents: ${error.message}`);
  }
}

/**
 * Delete all vectors from Pinecone index
 * WARNING: This permanently deletes ALL data from the index
 * @param {string} namespace - Optional namespace to clear (defaults to default namespace)
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function deleteAllVectors(namespace = '') {
  try {
    const index = await initializePinecone();
    
    // Pinecone SDK v6.x has deleteAll() method directly on the index
    // Get the namespace-specific index if namespace is provided
    const targetIndex = namespace ? index.namespace(namespace) : index;
    
    // Use deleteAll() method (Pinecone SDK v6.x)
    await targetIndex.deleteAll();
    
    const namespaceMsg = namespace ? ` from namespace '${namespace}'` : '';
    console.log(`[Pinecone] All vectors deleted successfully${namespaceMsg}`);
    
    return {
      success: true,
      message: `All vectors deleted successfully from Pinecone index${namespaceMsg}`
    };
  } catch (error) {
    console.error('Error deleting all vectors:', error);
    throw new Error(`Failed to delete all vectors: ${error.message}`);
  }
}

module.exports = {
  embedAndStore,
  searchSimilar,
  initializePinecone,
  deleteAllVectors
};
