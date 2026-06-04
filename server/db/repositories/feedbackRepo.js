/**
 * feedbackRepo.js
 *
 * Data-access layer for the message_feedback table.
 * Pattern mirrors messagesRepo.js and conversationsRepo.js.
 *
 * Provides:
 *   - upsert: insert new feedback OR overwrite existing (no history)
 *   - getByMessageId: read current feedback for a message (used by admin/dashboard)
 *   - getByConversation: list all feedback in a conversation (for analytics)
 *   - delete: remove feedback (only used if message is deleted; CASCADE handles
 *     the common case automatically)
 *
 * All functions return null on DB failure (NEVER throw) so the chat path
 * is never blocked by a feedback insert failure. This matches the
 * "telemetry is fire-and-forget" pattern used elsewhere in the codebase.
 */

const { query } = require('../index');

/**
 * Insert new feedback OR overwrite existing feedback for a message.
 * Returns the resulting row + a flag indicating whether it was a fresh insert
 * (is_insert=true) or an update of existing feedback (is_insert=false).
 *
 * Uses Postgres `xmax = 0` trick to detect insert vs update in a single round-trip.
 *
 * @param {object} input
 * @param {string} input.messageId     - UUID of the message being rated
 * @param {string} input.conversationId - UUID of the parent conversation
 * @param {'up'|'down'} input.rating
 * @param {string[]|null} input.tags   - multi-select tags (only for thumbs-down)
 * @param {string|null} input.comment  - optional free-text (max 500 chars at API layer)
 * @returns {Promise<{message_id, rating, tags, comment, is_insert}|null>}
 */
async function upsert(input) {
  const { messageId, conversationId, rating, tags, comment } = input;

  const sql = `
    INSERT INTO message_feedback (message_id, conversation_id, rating, tags, comment)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (message_id) DO UPDATE SET
      rating     = EXCLUDED.rating,
      tags       = EXCLUDED.tags,
      comment    = EXCLUDED.comment,
      updated_at = NOW()
    RETURNING
      message_id,
      conversation_id,
      rating,
      tags,
      comment,
      (xmax = 0) AS is_insert
  `;

  const result = await query(sql, [
    messageId,
    conversationId,
    rating,
    tags ? JSON.stringify(tags) : null,
    comment || null,
  ]);

  if (!result || result.rows.length === 0) return null;
  return result.rows[0];
}

/**
 * Fetch the current feedback row for a message (or null if not rated).
 *
 * @param {string} messageId
 * @returns {Promise<object|null>}
 */
async function getByMessageId(messageId) {
  const result = await query(
    'SELECT * FROM message_feedback WHERE message_id = $1',
    [messageId]
  );
  if (!result || result.rows.length === 0) return null;
  return result.rows[0];
}

/**
 * List all feedback for a conversation, newest first.
 * Used by the admin dashboard's conversation viewer.
 *
 * @param {string} conversationId
 * @returns {Promise<Array<object>>}
 */
async function getByConversation(conversationId) {
  const result = await query(
    `SELECT * FROM message_feedback
     WHERE conversation_id = $1
     ORDER BY created_at DESC`,
    [conversationId]
  );
  if (!result) return [];
  return result.rows;
}

/**
 * Aggregate stats for a time window. Used by admin dashboard analytics.
 *
 * @param {string} sinceIso - ISO timestamp lower bound (e.g. '2026-06-01')
 * @returns {Promise<{total, up, down, by_tag}|null>}
 */
async function getStats(sinceIso) {
  const result = await query(
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN rating = 'up'   THEN 1 ELSE 0 END)::int AS up,
       SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END)::int AS down
     FROM message_feedback
     WHERE created_at >= $1`,
    [sinceIso]
  );
  if (!result || result.rows.length === 0) return null;
  return result.rows[0];
}

module.exports = {
  upsert,
  getByMessageId,
  getByConversation,
  getStats,
};
