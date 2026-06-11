/**
 * learned_qa repository — Drop 2 (Episodic Memory), Phase A.
 *
 * Data layer for validated Q&A pairs promoted from thumbs-up feedback.
 * Lifecycle: createCandidate ('pending') -> setStatus ('approved'|'rejected')
 * -> markEmbedded (after Phase C pushes the vector to the Pinecone
 * 'learned_qa' source). This file is storage only — promotion (Phase B) and
 * embedding/retrieval (Phase C) are wired separately, the same way
 * retrievalsRepo shipped unused in Drop 4-light v1.
 *
 * question / answer are copied from already-redacted messages rows.
 */

const { query } = require('../index');

/**
 * Create a learned_qa candidate. Idempotent on source_message_id, so a repeated
 * thumbs-up on the same answer won't create duplicate candidates.
 *
 * @param {object} params
 * @param {string} params.question                  - already-redacted user question
 * @param {string} params.answer                    - already-redacted assistant answer
 * @param {string|null} params.language             - 'nb' | 'en'
 * @param {string|null} params.sourceMessageId      - assistant message UUID that was rated
 * @param {string|null} params.sourceConversationId - conversation UUID (internal)
 * @returns {Promise<object|null>} the row, or null if it already existed / invalid input
 */
async function createCandidate(params) {
  const {
    question,
    answer,
    language = null,
    sourceMessageId = null,
    sourceConversationId = null,
  } = params;

  if (!question || !answer) return null;

  const result = await query(
    `INSERT INTO learned_qa
       (question, answer, language, source_message_id, source_conversation_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_message_id) WHERE source_message_id IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [question, answer, language, sourceMessageId, sourceConversationId]
  );

  return result?.rows?.[0] || null;
}

/**
 * Fetch a candidate by id.
 */
async function findById(id) {
  if (!id) return null;
  const result = await query('SELECT * FROM learned_qa WHERE id = $1', [id]);
  return result?.rows?.[0] || null;
}

/**
 * List candidates by status (e.g. the 'pending' approval queue).
 */
async function listByStatus(status, limit = 20, offset = 0) {
  const result = await query(
    `SELECT * FROM learned_qa
      WHERE status = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );
  return result?.rows || [];
}

/**
 * Approve or reject a candidate. approved_by is preserved if not supplied.
 */
async function setStatus(id, status, approvedBy = null) {
  if (!id || !['pending', 'approved', 'rejected'].includes(status)) return null;
  const result = await query(
    `UPDATE learned_qa
        SET status = $2,
            approved_by = COALESCE($3, approved_by),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, status, approvedBy]
  );
  return result?.rows?.[0] || null;
}

/**
 * Approved entries not yet embedded into Pinecone — the Phase C embed worker.
 */
async function listApprovedNeedingEmbedding(limit = 100) {
  const result = await query(
    `SELECT * FROM learned_qa
      WHERE status = 'approved' AND embedding_id IS NULL
      ORDER BY updated_at ASC
      LIMIT $1`,
    [limit]
  );
  return result?.rows || [];
}

/**
 * Record that an approved entry has been embedded into the Pinecone
 * 'learned_qa' source.
 */
async function markEmbedded(id, embeddingId) {
  if (!id || !embeddingId) return null;
  const result = await query(
    `UPDATE learned_qa
        SET embedding_id = $2,
            embedded_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, embeddingId]
  );
  return result?.rows?.[0] || null;
}

/**
 * Edit a candidate's question and/or answer (admin curation, before or after
 * approval). Clears embedding_id/embedded_at so the Phase C embed worker
 * re-embeds the edited content — the stable Pinecone id learned_qa_<id>
 * overwrites the old vector. Pass only the fields to change; omitted fields
 * (undefined/null) are preserved.
 *
 * @param {string} id
 * @param {object} fields
 * @param {string} [fields.question]
 * @param {string} [fields.answer]
 * @returns {Promise<object|null>} the updated row, or null if id/fields invalid
 */
async function updateContent(id, fields = {}) {
  const { question = null, answer = null } = fields;
  if (!id) return null;
  if (question == null && answer == null) return null;
  const result = await query(
    `UPDATE learned_qa
        SET question = COALESCE($2, question),
            answer = COALESCE($3, answer),
            embedding_id = NULL,
            embedded_at = NULL,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, question, answer]
  );
  return result?.rows?.[0] || null;
}

module.exports = {
  createCandidate,
  findById,
  listByStatus,
  setStatus,
  listApprovedNeedingEmbedding,
  markEmbedded,
  updateContent,
};
