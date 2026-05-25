/**
 * Retrievals repository.
 *
 * One row per KB chunk that was shown to the synthesis model for a given
 * message. Lets us answer "what did the agent see?" — the foundation for
 * debugging hallucinations and identifying KB gaps.
 *
 * Inserts are batched into a single multi-row INSERT for efficiency.
 */

const { query } = require('../index');

const PREVIEW_MAX_CHARS = 300;

function truncatePreview(text) {
  if (!text) return null;
  return text.length > PREVIEW_MAX_CHARS
    ? text.slice(0, PREVIEW_MAX_CHARS) + '…'
    : text;
}

/**
 * Insert multiple retrievals at once (typical: 10 chunks per message).
 *
 * @param {string} messageId
 * @param {string} queryText  - the search query used
 * @param {Array<{chunk_id, source, score, text, rank?}>} chunks
 * @returns {Promise<number>} number of rows inserted (0 on error)
 */
async function insertBatch(messageId, queryText, chunks) {
  if (!messageId || !Array.isArray(chunks) || chunks.length === 0) return 0;

  // Build a single multi-row INSERT. Each row has 6 placeholders.
  const placeholders = [];
  const values = [];

  chunks.forEach((c, idx) => {
    const base = idx * 6;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`
    );
    values.push(
      messageId,
      queryText,
      c.chunk_id || c.chunkId || null,
      c.source || null,
      typeof c.score === 'number' ? c.score : null,
      c.rank || idx + 1,
    );
  });

  // Add text_preview as a 7th column per row — append separately for clarity
  // Re-build with 7 placeholders
  const placeholders2 = [];
  const values2 = [];
  chunks.forEach((c, idx) => {
    const base = idx * 7;
    placeholders2.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`
    );
    values2.push(
      messageId,
      queryText,
      c.chunk_id || c.chunkId || null,
      c.source || null,
      typeof c.score === 'number' ? c.score : null,
      c.rank || idx + 1,
      truncatePreview(c.text),
    );
  });

  const result = await query(
    `INSERT INTO retrievals
       (message_id, query, chunk_id, source, score, rank, text_preview)
     VALUES ${placeholders2.join(', ')}`,
    values2
  );

  return result?.rowCount || 0;
}

/**
 * Get all retrievals for a given message id.
 */
async function findByMessageId(messageId) {
  const result = await query(
    'SELECT * FROM retrievals WHERE message_id = $1 ORDER BY rank ASC',
    [messageId]
  );
  return result?.rows || [];
}

/**
 * Aggregate: which chunks are retrieved most often?
 */
async function findTopChunks(intervalText = '7 days', limit = 20) {
  const result = await query(
    `SELECT chunk_id, source,
            COUNT(*) as retrieval_count,
            ROUND(AVG(score)::numeric, 3) as avg_score,
            ROUND(AVG(rank)::numeric, 1) as avg_rank
       FROM retrievals
      WHERE created_at > NOW() - INTERVAL '${intervalText.replace(/'/g, '')}'
        AND chunk_id IS NOT NULL
      GROUP BY chunk_id, source
      ORDER BY retrieval_count DESC
      LIMIT $1`,
    [limit]
  );
  return result?.rows || [];
}

module.exports = {
  insertBatch,
  findByMessageId,
  findTopChunks,
};
