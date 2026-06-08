/**
 * retrievalsRepo.js
 *
 * Drop 4-light — telemetry layer for RAG retrievals. Every successful or
 * refused search writes one row. NEVER throws — fire-and-forget so the chat
 * path is never blocked by a telemetry insert failure.
 *
 * Pattern mirrors messagesRepo / feedbackRepo / adminRepo.
 */

const { query } = require('../index');

const MAX_TEXT_PREVIEW = 500;

/**
 * Insert a retrieval trace row. Returns null on failure (never throws).
 *
 * @param {object} input
 * @param {string}      input.messageId
 * @param {string}      input.conversationId
 * @param {string}      input.source             - 'visor_faqs' | 'visor_products' | 'visor_tickets'
 * @param {string}      input.queryText          - the actual query passed to the embedding service
 * @param {string|null} input.topMatchId         - chunk ID of best hit (nullable for empty results)
 * @param {number|null} input.topMatchScore      - 0-1 cosine of best hit
 * @param {string|null} input.topMatchText       - first MAX_TEXT_PREVIEW chars of best hit
 * @param {number}      input.resultCount        - how many results came back from Pinecone
 * @param {number|null} input.floor              - the RAG_FLOOR_* used for the comparison
 * @param {boolean}     input.passedFloor        - true if the best score >= floor
 * @returns {Promise<{id}|null>}
 */
async function insert(input) {
  const {
    messageId,
    conversationId,
    source,
    queryText,
    topMatchId = null,
    topMatchScore = null,
    topMatchText = null,
    resultCount = 0,
    floor = null,
    passedFloor = false,
  } = input || {};

  if (!messageId || !conversationId || !source) {
    // Quiet drop — invalid input means upstream wiring is broken; don't crash on it.
    return null;
  }

  const truncatedText =
    typeof topMatchText === 'string' && topMatchText.length > MAX_TEXT_PREVIEW
      ? topMatchText.slice(0, MAX_TEXT_PREVIEW)
      : topMatchText;

  const result = await query(
    `INSERT INTO retrievals
       (message_id, conversation_id, source, query, top_match_id, top_match_score,
        top_match_text, result_count, floor, passed_floor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      messageId,
      conversationId,
      source,
      queryText || '',
      topMatchId,
      topMatchScore,
      truncatedText,
      resultCount,
      floor,
      passedFloor === true,
    ]
  );

  if (!result || result.rows.length === 0) return null;
  return result.rows[0];
}

/**
 * Fetch all retrievals for a message (newest first). Used by admin drill-down.
 *
 * @param {string} messageId
 * @returns {Promise<Array>}
 */
async function getByMessageId(messageId) {
  const result = await query(
    `SELECT * FROM retrievals WHERE message_id = $1 ORDER BY created_at ASC`,
    [messageId]
  );
  if (!result) return [];
  return result.rows;
}

/**
 * Fetch recent low-confidence retrievals for failure analysis.
 *
 * @param {object} opts
 * @param {number} opts.limit
 * @param {string} opts.source - optional filter
 * @returns {Promise<Array>}
 */
async function getRecentLowConfidence(opts = {}) {
  const limit = Math.min(parseInt(opts.limit, 10) || 50, 200);
  const params = [];
  let whereSrc = '';
  if (opts.source) {
    params.push(opts.source);
    whereSrc = `AND source = $${params.length}`;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  const result = await query(
    `SELECT r.*, m.content AS message_content, m.role AS message_role
     FROM retrievals r
     LEFT JOIN messages m ON m.id = r.message_id
     WHERE r.passed_floor = false ${whereSrc}
     ORDER BY r.created_at DESC
     LIMIT ${limitParam}`,
    params
  );
  if (!result) return [];
  return result.rows;
}

module.exports = {
  insert,
  getByMessageId,
  getRecentLowConfidence,
};
