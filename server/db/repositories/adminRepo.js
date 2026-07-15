/**
 * adminRepo.js
 *
 * Read-only data access for the admin dashboard's Conversations + Feedback
 * browsing views. All queries are SELECT-only; no admin DB writes happen here.
 *
 * Pattern mirrors messagesRepo.js / feedbackRepo.js. All functions return null
 * or empty arrays on DB failure (never throw) so the admin UI degrades
 * gracefully if the connection pool is exhausted.
 *
 * Pagination strategy: LIMIT/OFFSET. Current scale (31 conversations, 124
 * messages) is tiny, so this is fine. If we ever push past ~10k conversations,
 * switch to cursor-based pagination (WHERE created_at < $cursor ORDER BY ...
 * LIMIT n). The function signatures will remain stable.
 */

const { query } = require('../index');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(n) {
  const parsed = parseInt(n, 10);
  if (!parsed || parsed < 1) return DEFAULT_LIMIT;
  if (parsed > MAX_LIMIT) return MAX_LIMIT;
  return parsed;
}

function clampOffset(n) {
  const parsed = parseInt(n, 10);
  if (!parsed || parsed < 0) return 0;
  return parsed;
}

// ============================================================================
// Conversations
// ============================================================================

/**
 * List conversations with optional filters.
 *
 * @param {object} opts
 * @param {number} opts.limit
 * @param {number} opts.offset
 * @param {string|null} opts.since        - ISO date lower bound on last_message_at
 * @param {boolean} opts.hasFeedback      - if true, only conversations with feedback
 * @param {'up'|'down'|null} opts.rating  - filter to conversations containing a
 *                                          message with this rating (requires hasFeedback)
 * @returns {Promise<{conversations: Array, total: number, limit, offset}>}
 */
async function listConversations(opts = {}) {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const since = opts.since || null;
  const hasFeedback = opts.hasFeedback === true;
  const rating = opts.rating === 'up' || opts.rating === 'down' ? opts.rating : null;

  // Build WHERE fragments
  const conds = [];
  const params = [];
  let p = 0;

  if (since) {
    p += 1;
    conds.push(`c.last_message_at >= $${p}`);
    params.push(since);
  }

  // Feedback filter: requires EXISTS subquery against message_feedback
  if (hasFeedback) {
    if (rating) {
      p += 1;
      conds.push(`EXISTS (
        SELECT 1 FROM message_feedback mf
        WHERE mf.conversation_id = c.id AND mf.rating = $${p}
      )`);
      params.push(rating);
    } else {
      conds.push(`EXISTS (
        SELECT 1 FROM message_feedback mf
        WHERE mf.conversation_id = c.id
      )`);
    }
  }

  const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

  // Get total count for pagination UI
  const countSql = `SELECT COUNT(*)::int AS total FROM conversations c ${whereSql}`;
  const countResult = await query(countSql, params);
  const total = countResult && countResult.rows[0] ? countResult.rows[0].total : 0;

  // Get paginated rows + per-conversation feedback summary
  p += 1;
  const limitParam = `$${p}`;
  params.push(limit);
  p += 1;
  const offsetParam = `$${p}`;
  params.push(offset);

  const listSql = `
    SELECT
      c.id,
      c.conversation_id,
      c.language,
      c.started_at,
      c.last_message_at,
      c.message_count,
      COALESCE(
        (SELECT SUM(CASE WHEN mf.rating = 'up'   THEN 1 ELSE 0 END)::int
         FROM message_feedback mf WHERE mf.conversation_id = c.id), 0
      ) AS feedback_up,
      COALESCE(
        (SELECT SUM(CASE WHEN mf.rating = 'down' THEN 1 ELSE 0 END)::int
         FROM message_feedback mf WHERE mf.conversation_id = c.id), 0
      ) AS feedback_down
    FROM conversations c
    ${whereSql}
    ORDER BY c.last_message_at DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const result = await query(listSql, params);
  const conversations = result ? result.rows : [];

  return { conversations, total, limit, offset };
}

/**
 * Fetch a single conversation by UUID with all its messages and per-message feedback.
 *
 * @param {string} conversationId - UUID (primary key, NOT the external widget format)
 * @returns {Promise<{conversation, messages}|null>}
 */
async function getConversationDetail(conversationId) {
  const convResult = await query(
    `SELECT id, conversation_id, language, user_agent, ip_country,
            started_at, last_message_at, message_count, metadata
     FROM conversations
     WHERE id = $1`,
    [conversationId]
  );
  if (!convResult || convResult.rows.length === 0) return null;
  const conversation = convResult.rows[0];

  // Pull messages WITH feedback in a single LEFT JOIN
  const msgResult = await query(
    `SELECT
       m.id,
       m.role,
       m.content,
       m.path,
       m.language,
       m.model,
       m.latency_ms,
       m.token_count,
       m.created_at,
       mf.rating       AS feedback_rating,
       mf.tags         AS feedback_tags,
       mf.comment      AS feedback_comment,
       mf.updated_at   AS feedback_updated_at
     FROM messages m
     LEFT JOIN message_feedback mf ON mf.message_id = m.id
     WHERE m.conversation_id = $1
     ORDER BY m.created_at ASC`,
    [conversationId]
  );

  const messages = msgResult ? msgResult.rows.map(row => ({
    id: row.id,
    role: row.role,
    content: row.content,
    path: row.path,
    language: row.language,
    model: row.model,
    latency_ms: row.latency_ms,
    token_count: row.token_count,
    created_at: row.created_at,
    feedback: row.feedback_rating ? {
      rating: row.feedback_rating,
      tags: row.feedback_tags,
      comment: row.feedback_comment,
      updated_at: row.feedback_updated_at,
    } : null,
  })) : [];

  return { conversation, messages };
}

// ============================================================================
// Feedback
// ============================================================================

/**
 * List feedback rows with optional rating filter, joined with the rated
 * message + parent conversation for context.
 *
 * @param {object} opts
 * @param {number} opts.limit
 * @param {number} opts.offset
 * @param {'up'|'down'|null} opts.rating
 * @param {string|null} opts.since
 * @returns {Promise<{feedback: Array, total: number, limit, offset}>}
 */
async function listFeedback(opts = {}) {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const rating = opts.rating === 'up' || opts.rating === 'down' ? opts.rating : null;
  const since = opts.since || null;

  const conds = [];
  const params = [];
  let p = 0;

  if (rating) {
    p += 1;
    conds.push(`mf.rating = $${p}`);
    params.push(rating);
  }
  if (since) {
    p += 1;
    conds.push(`mf.created_at >= $${p}`);
    params.push(since);
  }

  const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

  // Total for pagination
  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM message_feedback mf ${whereSql}`,
    params
  );
  const total = countResult && countResult.rows[0] ? countResult.rows[0].total : 0;

  // Paginated detail
  p += 1;
  const limitParam = `$${p}`;
  params.push(limit);
  p += 1;
  const offsetParam = `$${p}`;
  params.push(offset);

  const listSql = `
    SELECT
      mf.message_id,
      mf.conversation_id,
      mf.rating,
      mf.tags,
      mf.comment,
      mf.created_at AS feedback_created_at,
      mf.updated_at AS feedback_updated_at,
      m.role           AS message_role,
      m.content        AS message_content,
      m.path           AS message_path,
      m.language       AS message_language,
      m.latency_ms     AS message_latency_ms,
      m.created_at     AS message_created_at,
      c.conversation_id AS conversation_external_id,
      c.language        AS conversation_language,
      c.started_at      AS conversation_started_at,
      prev.content      AS prev_user_message_content,
      prev.created_at   AS prev_user_message_created_at
    FROM message_feedback mf
    JOIN messages m       ON m.id = mf.message_id
    JOIN conversations c  ON c.id = mf.conversation_id
    LEFT JOIN LATERAL (
      SELECT content, created_at
      FROM messages
      WHERE conversation_id = mf.conversation_id
        AND role = 'user'
        AND created_at < m.created_at
      ORDER BY created_at DESC
      LIMIT 1
    ) prev ON true
    ${whereSql}
    ORDER BY mf.updated_at DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const result = await query(listSql, params);

  const feedback = result ? result.rows.map(row => ({
    message_id: row.message_id,
    conversation_id: row.conversation_id,
    rating: row.rating,
    tags: row.tags,
    comment: row.comment,
    created_at: row.feedback_created_at,
    updated_at: row.feedback_updated_at,
    message: {
      role: row.message_role,
      content: row.message_content,
      path: row.message_path,
      language: row.message_language,
      latency_ms: row.message_latency_ms,
      created_at: row.message_created_at,
    },
    conversation: {
      id: row.conversation_id,
      conversation_id: row.conversation_external_id,
      language: row.conversation_language,
      started_at: row.conversation_started_at,
    },
    prev_user_message: row.prev_user_message_content ? {
      content: row.prev_user_message_content,
      created_at: row.prev_user_message_created_at,
    } : null,
  })) : [];

  return { feedback, total, limit, offset };
}

// ============================================================================
// Stats (for future analytics; minimal for now)
// ============================================================================

/**
 * Get summary counts. Used by the dashboard's overview / sidebar badges later.
 *
 * @returns {Promise<{conversations, messages, feedback, thumbs_up, thumbs_down}|null>}
 */
async function getOverviewStats() {
  const result = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM conversations)                           AS conversations,
      (SELECT COUNT(*)::int FROM messages)                                AS messages,
      (SELECT COUNT(*)::int FROM message_feedback)                        AS feedback,
      (SELECT COUNT(*)::int FROM message_feedback WHERE rating = 'up')    AS thumbs_up,
      (SELECT COUNT(*)::int FROM message_feedback WHERE rating = 'down')  AS thumbs_down,
      (SELECT COUNT(DISTINCT (query, source))::int FROM retrievals
        WHERE passed_floor = false)                                      AS unanswered_patterns
  `);
  if (!result || result.rows.length === 0) return null;
  return result.rows[0];
}

// ============================================================================
// Learned QA (episodic memory — Drop 2)
// ============================================================================

/**
 * List learned_qa candidates by status (default 'pending'), paginated.
 * Read-only; status mutations live in learnedQaRepo.setStatus.
 *
 * @param {object} opts
 * @param {'pending'|'approved'|'rejected'} opts.status  - default 'pending'
 * @param {number} opts.limit
 * @param {number} opts.offset
 * @returns {Promise<{learned_qa: Array, total: number, limit, offset}>}
 */
async function listLearnedQa(opts = {}) {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const status =
    ['pending', 'approved', 'rejected'].includes(opts.status) ? opts.status : 'pending';

  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM learned_qa WHERE status = $1`,
    [status]
  );
  const total = countResult && countResult.rows[0] ? countResult.rows[0].total : 0;

  const result = await query(
    `SELECT
       id, question, answer, language, status,
       source_message_id, source_conversation_id,
       embedding_id, embedded_at, approved_by,
       created_at, updated_at
     FROM learned_qa
     WHERE status = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );
  const learned_qa = result ? result.rows : [];

  return { learned_qa, total, limit, offset };
}

module.exports = {
  listConversations,
  getConversationDetail,
  listFeedback,
  getOverviewStats,
  listLearnedQa,
};
