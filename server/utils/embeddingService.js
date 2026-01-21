const { OpenAIEmbeddings } = require('@langchain/openai');
const { Pinecone } = require('@pinecone-database/pinecone');

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

/**
 * Create embeddings and store them in Pinecone
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

    // Generate embeddings for all documents
    const texts = docs.map(doc => doc.pageContent || doc);
    const vectors = await embeddings.embedDocuments(texts);

    // Prepare vectors for upsert
    const uploadTimestamp = Date.now();
    const vectorsToUpsert = vectors.map((embedding, idx) => {
      const doc = docs[idx];
      const chunkId = `${sourceName}_chunk_${idx}_${uploadTimestamp}`;
      
      return {
        id: chunkId,
        values: embedding,
        metadata: {
          source: sourceName,
          chunk_id: chunkId,
          text: doc.pageContent || doc,
          upload_timestamp: uploadTimestamp, // Add timestamp for prioritizing recent uploads
        },
      };
    });

    // Upsert vectors into Pinecone
    await index.upsert(vectorsToUpsert);

    console.log(`Successfully embedded and stored ${vectorsToUpsert.length} chunks from ${sourceName}`);
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
      uploadTimestamp: match.metadata?.upload_timestamp || 0, // Default to 0 for old data without timestamp
    }));

    // AGGRESSIVE RECENCY PRIORITIZATION:
    // Separate results into "new" (has timestamp > 0) and "old" (timestamp = 0)
    const newResults = allResults.filter(r => r.uploadTimestamp > 0);
    const oldResults = allResults.filter(r => r.uploadTimestamp === 0);

    // Sort new results by timestamp (newest first), then by score
    newResults.sort((a, b) => {
      if (a.uploadTimestamp !== b.uploadTimestamp) {
        return b.uploadTimestamp - a.uploadTimestamp; // Newest first
      }
      return b.score - a.score; // Higher score first
    });

    // Sort old results by score only
    oldResults.sort((a, b) => b.score - a.score);

    // STRATEGY: Prioritize new uploads heavily
    // If we have new results, use them first (even if scores are lower)
    // Only fill remaining slots with old results if needed
    let finalResults = [];
    
    if (newResults.length > 0) {
      // We have new uploads - prioritize them heavily
      // Take up to topK from new results
      const newCount = Math.min(newResults.length, topK);
      finalResults = newResults.slice(0, newCount);
      
      // If we need more results and have old results, add them
      if (finalResults.length < topK && oldResults.length > 0) {
        const remainingSlots = topK - finalResults.length;
        finalResults = finalResults.concat(oldResults.slice(0, remainingSlots));
      }
      
      console.log(`[RAG Search] Query: "${query}" | Prioritizing ${newResults.length} new upload(s) over ${oldResults.length} old result(s)`);
    } else {
      // No new uploads - fall back to old results
      finalResults = oldResults.slice(0, topK);
      console.log(`[RAG Search] Query: "${query}" | No new uploads found, using ${finalResults.length} old result(s)`);
    }

    // Remove uploadTimestamp from final results
    finalResults = finalResults.map(({ uploadTimestamp, ...rest }) => rest);

    // Log for debugging (only if multiple sources found)
    const uniqueSources = [...new Set(finalResults.map(r => r.source))];
    if (uniqueSources.length > 1) {
      console.log(`[RAG Search] Query: "${query}" | Found ${finalResults.length} results from ${uniqueSources.length} sources:`, uniqueSources);
    }

    return finalResults;
  } catch (error) {
    console.error('Error in searchSimilar:', error);
    throw new Error(`Failed to search similar documents: ${error.message}`);
  }
}

/**
 * Delete all vectors from Pinecone index
 * WARNING: This permanently deletes ALL data from the index
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function deleteAllVectors() {
  try {
    const index = await initializePinecone();
    
    // Delete all vectors from the default namespace
    // Using deleteAll() method (available in Pinecone SDK v1.0+)
    // For default namespace, we can use deleteAll() directly
    try {
      // Try the newer deleteAll() method first
      await index.deleteAll();
    } catch (error) {
      // Fallback: If deleteAll() doesn't exist, use delete with deleteAll: true
      if (error.message.includes('deleteAll') || error.message.includes('not a function')) {
        // Alternative method: delete with deleteAll parameter
        await index.delete({ deleteAll: true });
      } else {
        throw error;
      }
    }
    
    console.log('[Pinecone] All vectors deleted successfully');
    return {
      success: true,
      message: 'All vectors deleted successfully from Pinecone index'
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
