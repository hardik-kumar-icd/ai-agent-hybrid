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

/**
 * Group low-confidence retrievals by (query, source) so the same recurring
 * question — the same failure asked many times — surfaces as one row with an
 * occurrence count, rather than being buried among individually-recent rows.
 * This is the ground-truth "what are customers asking that we can't answer"
 * signal: fully instrumented since Drop 4-light, but never surfaced anywhere
 * until now. Exact-string grouping won't cluster paraphrases of the same
 * intent, but repeated near-identical phrasing (the common case) groups fine.
 *
 * @param {object} opts
 * @param {number} opts.limit  - max distinct (query, source) rows (default 20, max 100)
 * @param {string} opts.since  - ISO date, optional — only rows from this point on
 * @returns {Promise<Array<{query, source, occurrences, last_seen, avg_score,
 *   floor, latest_conversation_id, latest_message_id}>>}
 */
async function getTopUnansweredQueries(opts = {}) {
  const limit = Math.min(parseInt(opts.limit, 10) || 20, 100);
  const params = [];
  let sinceClause = '';
  if (opts.since) {
    params.push(opts.since);
    sinceClause = `AND created_at >= $${params.length}`;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  const result = await query(
    `SELECT
       query,
       source,
       COUNT(*)::int AS occurrences,
       MAX(created_at) AS last_seen,
       AVG(top_match_score) AS avg_score,
       MAX(floor) AS floor,
       (ARRAY_AGG(conversation_id ORDER BY created_at DESC))[1] AS latest_conversation_id,
       (ARRAY_AGG(message_id ORDER BY created_at DESC))[1] AS latest_message_id
     FROM retrievals
     WHERE passed_floor = false ${sinceClause}
     GROUP BY query, source
     ORDER BY occurrences DESC, last_seen DESC
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
  getTopUnansweredQueries,
};
