/**
 * episodicMemoryService.js — Drop 2 (Episodic Memory), Phase B: promotion.
 *
 * Turns a thumbs-up on an assistant answer into a 'pending' learned_qa
 * candidate. The candidate's `answer` is the rated assistant message; the
 * `question` is the user message that immediately preceded it in the same
 * conversation.
 *
 * Approval-gated: this only ever creates 'pending' rows. Embedding into the
 * Pinecone 'learned_qa' source happens later (Phase C), after an admin
 * approves the candidate.
 *
 * Promotion is idempotent (learnedQaRepo.createCandidate is a no-op on a repeat
 * thumbs-up for the same message) and NEVER throws — it must not break the
 * feedback path. Callers invoke it fire-and-forget via setImmediate.
 *
 * question/answer are read from messages.content, which is already PII-redacted.
 */

const { query } = require('../db/index');
const learnedQaRepo = require('../db/repositories/learnedQaRepo');

/**
 * Fetch the (question, answer, language) triple for a rated assistant message.
 * `question` is the most recent user message at or before the assistant message
 * within the same conversation (via LATERAL join).
 *
 * @param {string} assistantMessageId
 * @returns {Promise<{answer: string, language: string|null, question: string|null}|null>}
 */
async function fetchQaPair(assistantMessageId) {
  const result = await query(
    `SELECT a.content  AS answer,
            a.language AS language,
            u.content  AS question
       FROM messages a
       LEFT JOIN LATERAL (
         SELECT content
           FROM messages
          WHERE conversation_id = a.conversation_id
            AND role = 'user'
            AND created_at <= a.created_at
          ORDER BY created_at DESC
          LIMIT 1
       ) u ON true
      WHERE a.id = $1 AND a.role = 'assistant'
      LIMIT 1`,
    [assistantMessageId]
  );
  return result?.rows?.[0] || null;
}

/**
 * Promote a thumbs-up'd assistant message into a pending learned_qa candidate.
 * Returns the created row, or null if there was nothing to learn / it already
 * existed. Never throws.
 *
 * @param {object} params
 * @param {string} params.messageId       - rated assistant message UUID
 * @param {string} params.conversationId  - internal conversation UUID
 * @returns {Promise<object|null>}
 */
async function promoteFromFeedback({ messageId, conversationId } = {}) {
  try {
    if (!messageId || !conversationId) return null;

    const pair = await fetchQaPair(messageId);
    if (!pair || !pair.question || !pair.answer) {
      // No preceding user message (or no answer text) — nothing to learn.
      return null;
    }

    const row = await learnedQaRepo.createCandidate({
      question: pair.question,
      answer: pair.answer,
      language: pair.language || null,
      sourceMessageId: messageId,
      sourceConversationId: conversationId,
    });

    return row; // null if a candidate already existed (idempotent)
  } catch (err) {
    console.error('[EpisodicMemory] promoteFromFeedback failed:', err.message);
    return null;
  }
}

module.exports = {
  promoteFromFeedback,
  fetchQaPair,
};
