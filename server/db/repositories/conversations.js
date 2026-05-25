/**
 * Conversations repository.
 *
 * One row per chat session. Identified externally by `conversation_id`
 * (the value the widget sends), internally by `id` (UUID).
 *
 * Methods always return null on DB error rather than throwing — the
 * telemetry layer is fire-and-forget and must never break the chat path.
 */

const { query } = require('../index');

/**
 * Find or create a conversation by its external conversation_id.
 *
 * Idempotent — if the conversation already exists, returns it with the
 * `last_message_at` and `message_count` updated.
 *
 * @param {object} params
 * @param {string} params.conversationId   - public conversation_id from widget
 * @param {string|null} params.userEmailHash
 * @param {string|null} params.userOrderHash
 * @param {string|null} params.language    - 'nb' | 'en'
 * @param {string|null} params.userAgent
 * @returns {Promise<{id: string} | null>}  - the internal UUID
 */
async function findOrCreate(params) {
  const {
    conversationId,
    userEmailHash = null,
    userOrderHash = null,
    language = null,
    userAgent = null,
  } = params;

  if (!conversationId) return null;

  // First try to find an existing conversation
  const existing = await query(
    'SELECT id FROM conversations WHERE conversation_id = $1 LIMIT 1',
    [conversationId]
  );

  if (existing?.rows?.length > 0) {
    // Update last_message_at + increment counter
    const updated = await query(
      `UPDATE conversations
         SET last_message_at = NOW(),
             message_count = message_count + 1,
             user_email_hash = COALESCE(user_email_hash, $2),
             user_order_hash = COALESCE(user_order_hash, $3),
             language = COALESCE(language, $4)
       WHERE conversation_id = $1
       RETURNING id`,
      [conversationId, userEmailHash, userOrderHash, language]
    );
    return updated?.rows?.[0] || null;
  }

  // Otherwise insert a new row
  const inserted = await query(
    `INSERT INTO conversations
       (conversation_id, user_email_hash, user_order_hash, language, user_agent, message_count)
     VALUES ($1, $2, $3, $4, $5, 1)
     ON CONFLICT (conversation_id) DO UPDATE
       SET last_message_at = NOW()
     RETURNING id`,
    [conversationId, userEmailHash, userOrderHash, language, userAgent]
  );

  return inserted?.rows?.[0] || null;
}

/**
 * Get a conversation by its internal UUID.
 */
async function findById(id) {
  const result = await query(
    'SELECT * FROM conversations WHERE id = $1',
    [id]
  );
  return result?.rows?.[0] || null;
}

/**
 * Get a conversation by its public conversation_id.
 */
async function findByConversationId(conversationId) {
  const result = await query(
    'SELECT * FROM conversations WHERE conversation_id = $1',
    [conversationId]
  );
  return result?.rows?.[0] || null;
}

/**
 * Delete a conversation by internal UUID (cascades to messages + retrievals).
 * Used by retention cleanup + future right-to-erasure endpoint.
 */
async function deleteById(id) {
  const result = await query(
    'DELETE FROM conversations WHERE id = $1 RETURNING id',
    [id]
  );
  return result?.rows?.length > 0;
}

/**
 * Find all conversations matching a given PII hash.
 * Used by the future right-to-erasure endpoint.
 */
async function findByPiiHash(hash) {
  const result = await query(
    `SELECT * FROM conversations
       WHERE user_email_hash = $1 OR user_order_hash = $1
       ORDER BY started_at DESC`,
    [hash]
  );
  return result?.rows || [];
}

module.exports = {
  findOrCreate,
  findById,
  findByConversationId,
  deleteById,
  findByPiiHash,
};
