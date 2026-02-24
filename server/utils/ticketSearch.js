const { searchSimilar } = require('./embeddingService');

/**
 * Search only in ticket-based chunks (ingested from tickets_fixed.jsonl).
 * This helper keeps ticket retrieval isolated from normal product/FAQ RAG.
 *
 * @param {string} query - User query text
 * @param {number} topK - Number of ticket chunks to return
 * @returns {Promise<Array<{ text: string, source: string, chunkId: string, score: number }>>}
 */
async function searchTickets(query, topK = 5) {
  // Fetch more results than needed, then filter down to tickets
  const fetchK = Math.max(topK * 5, 20);
  const all = await searchSimilar(query, fetchK);

  const ticketDocs = all.filter(
    (doc) => doc && typeof doc.source === 'string' && doc.source === 'tickets_fixed.jsonl'
  );

  return ticketDocs.slice(0, topK);
}

module.exports = {
  searchTickets,
};

