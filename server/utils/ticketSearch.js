const { searchSimilarFiltered } = require('./embeddingService');

/**
 * Search ticket chunks only. Keeps ticket retrieval isolated from FAQ/product RAG.
 *
 * After Drop 2 PR #12 ingests fresh tickets, chunks live under source
 * 'visor_tickets'. During the transition window (between PR #10 and PR #12),
 * this helper also queries the legacy 'tickets_fixed.jsonl' source so existing
 * ticket retrieval doesn't break during the rollout.
 *
 * @param {string} query - User query text
 * @param {number} topK - Number of ticket chunks to return
 * @returns {Promise<Array<{ text: string, source: string, chunkId: string, score: number }>>}
 */
async function searchTickets(query, topK = 5) {
  const newSource = await searchSimilarFiltered(query, 'visor_tickets', topK);
  if (newSource && newSource.length > 0) return newSource;

  const legacy = await searchSimilarFiltered(query, 'tickets_fixed.jsonl', topK);
  return legacy || [];
}

module.exports = {
  searchTickets,
};
