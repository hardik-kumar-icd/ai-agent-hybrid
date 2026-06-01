/**
 * embeddingService.js  (updated for FAQ fast-path PR)
 *
 * Changes vs. the latency PR version:
 *   - searchSimilar() now consults embeddingCache before calling OpenAI
 *   - Cache hits skip the embedding API entirely (saves ~300-500ms)
 *   - Pinecone query still runs every time (we don't cache retrieval results)
 *
 * Drop-in replacement for server/utils/embeddingService.js
 */

const { OpenAIEmbeddings } = require('@langchain/openai');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Tiktoken } = require('js-tiktoken/lite');
const cl100k_base = require('js-tiktoken/ranks/cl100k_base');
const { getCachedEmbedding, setCachedEmbedding } = require('./embeddingCache');

let pineconeClient = null;
let pineconeIndex = null;

async function initializePinecone() {
  if (!process.env.PINECONE_API_KEY) {
    throw new Error('PINECONE_API_KEY is not set in environment variables');
  }
  if (!process.env.PINECONE_INDEX_NAME) {
    throw new Error('PINECONE_INDEX_NAME is not set in environment variables');
  }

  if (!pineconeClient) {
    pineconeClient = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

    const indexName = process.env.PINECONE_INDEX_NAME;

    try {
      const indexList = await pineconeClient.listIndexes();
      const indexExists = indexList.indexes?.some((idx) => idx.name === indexName);

      if (!indexExists) {
        console.log(`Index '${indexName}' not found. Creating new index...`);
        const dimension = 3072; // text-embedding-3-large
        await pineconeClient.createIndex({
          name: indexName,
          dimension,
          metric: 'cosine',
          spec: {
            serverless: {
              cloud: 'aws',
              region: process.env.PINECONE_REGION || 'us-east-1',
            },
          },
        });

        console.log(`Index '${indexName}' created. Waiting for it to be ready...`);
        let ready = false;
        let attempts = 0;
        while (!ready && attempts < 30) {
          await new Promise((r) => setTimeout(r, 1000));
          const indexes = await pineconeClient.listIndexes();
          const index = indexes.indexes?.find((idx) => idx.name === indexName);
          if (index && index.status?.ready) ready = true;
          attempts += 1;
        }
        if (!ready) {
          throw new Error(`Index '${indexName}' was created but is not ready yet. Please retry shortly.`);
        }
        console.log(`Index '${indexName}' is ready.`);
      }
    } catch (error) {
      if (error.message.includes('404') || error.message.includes('not found')) {
        console.log('Could not check index existence. Attempting to use index directly...');
      } else {
        console.error('Error checking/creating index:', error.message);
      }
    }

    pineconeIndex = pineconeClient.index(indexName);
  }

  return pineconeIndex;
}

const EMBED_BATCH_SIZE = 100;
const MAX_EMBED_TOKENS = 8180;

let _embeddingEncoder = null;
function getEmbeddingEncoder() {
  if (!_embeddingEncoder) _embeddingEncoder = new Tiktoken(cl100k_base);
  return _embeddingEncoder;
}

function truncateForEmbedding(text) {
  if (!text || typeof text !== 'string') return '';
  const enc = getEmbeddingEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= MAX_EMBED_TOKENS) return text;
  const truncated = enc.decode(tokens.slice(0, MAX_EMBED_TOKENS));
  return truncated + ' [truncated]';
}

async function embedAndStore(docs, sourceName) {
  try {
    const index = await initializePinecone();
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
      const texts = batch.map((doc) => truncateForEmbedding(doc.pageContent || doc));
      const vectors = await embeddings.embedDocuments(texts);

      const vectorsToUpsert = vectors.map((embedding, idx) => {
        const doc = batch[idx];
        const globalIdx = offset + idx;
        const chunkId = `${sourceName}_chunk_${globalIdx}_${uploadTimestamp}`;
        const storedText = truncateForEmbedding(doc.pageContent || doc);
        // Merge any extra metadata supplied by the caller (e.g. product fields).
        // Reserved keys (source, chunk_id, text, upload_timestamp) always win.
        const customMetadata = (doc && typeof doc === 'object' && doc.metadata) || {};
        return {
          id: chunkId,
          values: embedding,
          metadata: {
            ...customMetadata,
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

      if (offset + EMBED_BATCH_SIZE < docs.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    console.log(`Successfully embedded and stored ${totalStored} chunks from ${sourceName}`);
  } catch (error) {
    console.error('Error in embedAndStore:', error);
    throw new Error(`Failed to embed and store documents: ${error.message}`);
  }
}

/**
 * Search for similar vectors in Pinecone.
 *
 * Performance optimizations (vs. earlier versions):
 *  1. No topK over-fetch (Pinecone already returns results sorted by score)
 *  2. Query embedding is cached in-process for 5 minutes (skip OpenAI call
 *     for repeat queries — common with FAQ-heavy traffic)
 *
 * @param {string} query
 * @param {number} topK
 * @returns {Promise<Array<{score, text, source, chunkId}>>}
 */
async function searchSimilar(query, topK = 10) {
  try {
    const index = await initializePinecone();

    // ---- Embedding (cached) ----
    let queryEmbedding = getCachedEmbedding(query);
    if (!queryEmbedding) {
      const embeddings = new OpenAIEmbeddings({
        openAIApiKey: process.env.OPENAI_API_KEY,
        modelName: 'text-embedding-3-large',
      });
      queryEmbedding = await embeddings.embedQuery(query);
      setCachedEmbedding(query, queryEmbedding);
    }

    // ---- Pinecone query (always fresh) ----
    const queryResponse = await index.query({
      vector: queryEmbedding,
      topK,
      includeMetadata: true,
    });

    const results = (queryResponse.matches || []).map((match) => ({
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

/**
 * Search for similar vectors in Pinecone, filtered by source.
 *
 * Uses Pinecone's server-side metadata filter (faster + always-correct vs.
 * fetching extra and filtering in memory). Used by the Drop 2 typed-search
 * tools (search_faq, search_products, search_tickets) to isolate retrieval
 * by source.
 *
 * @param {string} query - Query text
 * @param {string} sourceName - Source to filter by (e.g. 'visor_faqs', 'visor_products', 'visor_tickets')
 * @param {number} topK - Number of top results to return
 * @returns {Promise<Array<{score, text, source, chunkId, metadata}>>}
 */
async function searchSimilarFiltered(query, sourceName, topK = 10) {
  try {
    const index = await initializePinecone();

    let queryEmbedding = getCachedEmbedding(query);
    if (!queryEmbedding) {
      const embeddings = new OpenAIEmbeddings({
        openAIApiKey: process.env.OPENAI_API_KEY,
        modelName: 'text-embedding-3-large',
      });
      queryEmbedding = await embeddings.embedQuery(query);
      setCachedEmbedding(query, queryEmbedding);
    }

    const queryResponse = await index.query({
      vector: queryEmbedding,
      topK,
      includeMetadata: true,
      filter: { source: { $eq: sourceName } },
    });

    return (queryResponse.matches || []).map((m) => ({
      score: m.score,
      text: m.metadata?.text || '',
      source: m.metadata?.source || sourceName,
      chunkId: m.metadata?.chunk_id || m.id,
      metadata: m.metadata || {},
    }));
  } catch (error) {
    console.error(`[searchSimilarFiltered:${sourceName}] Error:`, error);
    throw new Error(`Failed to search ${sourceName}: ${error.message}`);
  }
}

async function deleteAllVectors(namespace = '') {
  try {
    const index = await initializePinecone();
    const targetIndex = namespace ? index.namespace(namespace) : index;
    await targetIndex.deleteAll();

    const namespaceMsg = namespace ? ` from namespace '${namespace}'` : '';
    console.log(`[Pinecone] All vectors deleted successfully${namespaceMsg}`);

    return {
      success: true,
      message: `All vectors deleted successfully from Pinecone index${namespaceMsg}`,
    };
  } catch (error) {
    console.error('Error deleting all vectors:', error);
    throw new Error(`Failed to delete all vectors: ${error.message}`);
  }
}

module.exports = {
  embedAndStore,
  searchSimilar,
  searchSimilarFiltered,
  initializePinecone,
  deleteAllVectors,
};
