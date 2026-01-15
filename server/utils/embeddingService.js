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
    const vectorsToUpsert = vectors.map((embedding, idx) => {
      const doc = docs[idx];
      const chunkId = `${sourceName}_chunk_${idx}_${Date.now()}`;
      
      return {
        id: chunkId,
        values: embedding,
        metadata: {
          source: sourceName,
          chunk_id: chunkId,
          text: doc.pageContent || doc,
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

    // Query Pinecone for similar vectors
    const queryResponse = await index.query({
      vector: queryEmbedding,
      topK: topK,
      includeMetadata: true,
    });

    // Extract and return the matches
    const results = queryResponse.matches.map(match => ({
      score: match.score,
      text: match.metadata?.text || '',
      source: match.metadata?.source || '',
      chunkId: match.metadata?.chunk_id || match.id,
    }));

    return results;
  } catch (error) {
    console.error('Error in searchSimilar:', error);
    throw new Error(`Failed to search similar documents: ${error.message}`);
  }
}

module.exports = {
  embedAndStore,
  searchSimilar,
  initializePinecone
};
