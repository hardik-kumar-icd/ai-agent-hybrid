/**
 * episodicMemoryService.js — Drop 2 (Episodic Memory).
 *
 * Phase B (promotion): turn a thumbs-up on an assistant answer into a 'pending'
 * learned_qa candidate (question = preceding user message, answer = rated msg).
 *
 * Phase C2 (embedding): embed approved-but-unembedded candidates into the
 * Pinecone 'learned_qa' source using the SAME 3072-dim model as the KB, then
 * mark them embedded. The KB partitions one index by a `source` metadata field
 * (not Pinecone namespaces), so learned answers live alongside
 * visor_faqs/products/tickets and are retrieved via
 * searchSimilarFiltered(query, LEARNED_QA_SOURCE, ...) in C3.
 *
 * Approval-gated: only admin-approved candidates are ever embedded. Promotion
 * is fire-and-forget and idempotent; embedding runs from a script/worker.
 *
 * NEVER throws into the feedback path. question/answer are read from
 * messages.content, which is already PII-redacted.
 */

const { query } = require('../db/index');
const learnedQaRepo = require('../db/repositories/learnedQaRepo');
const embeddingService = require('../utils/embeddingService');

// Pinecone metadata `source` value for episodic-memory vectors.
const LEARNED_QA_SOURCE = 'learned_qa';

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

/**
 * Embed approved-but-unembedded learned_qa candidates into the Pinecone
 * 'learned_qa' source. Embeds the QUESTION (so similar future questions match)
 * and carries answer + language + learned_qa id in metadata. Marks each row
 * embedded on success. Per-item errors are logged and skipped so one bad row
 * can't block the rest. Safe to re-run — only unembedded approved rows are
 * processed.
 *
 * @param {object} opts
 * @param {number} opts.limit - max candidates this run (default 50)
 * @returns {Promise<{processed: number, embedded: number, failed: number}>}
 */
/**
 * Embed a single learned_qa row's QUESTION into the Pinecone 'learned_qa'
 * source and mark it embedded. Shared by the batch worker and the admin approve
 * endpoint. Throws on failure — callers decide how to handle it.
 *
 * @param {object} row - learned_qa row (needs id, question, answer, language)
 * @returns {Promise<object|null>} the updated row (embedding_id set)
 */
async function embedRow(row) {
  const embeddingId = `learned_qa_${row.id}`;
  // Pinecone metadata can't hold null — only attach language if present.
  // approved_at (epoch ms) lets retrieval-time code judge staleness without a
  // DB round trip — see LEARNED_QA_STALE_DAYS in visorAgentStream.js.
  const metadata = {
    answer: row.answer,
    learned_qa_id: row.id,
    approved_at: new Date(row.updated_at).getTime(),
  };
  if (row.language) metadata.language = row.language;

  await embeddingService.embedAndStore(
    [{ id: embeddingId, pageContent: row.question, metadata }],
    LEARNED_QA_SOURCE
  );
  return learnedQaRepo.markEmbedded(row.id, embeddingId);
}

async function embedApprovedCandidates({ limit = 50 } = {}) {
  const candidates = await learnedQaRepo.listApprovedNeedingEmbedding(limit);
  let embedded = 0;
  let failed = 0;

  for (const row of candidates) {
    try {
      await embedRow(row);
      embedded += 1;
    } catch (err) {
      failed += 1;
      console.error(`[EpisodicMemory] embed failed for ${row.id}:`, err.message);
    }
  }

  return { processed: candidates.length, embedded, failed };
}

/**
 * Embed a single APPROVED candidate by id — used by the admin approve endpoint
 * so approval makes the answer live immediately (no CLI worker run needed).
 * Guards: only an approved, not-yet-embedded row is embedded. Never throws;
 * returns { ok, row?, reason? }. On failure the row stays approved+unembedded
 * and the batch worker / a re-approve remains a fallback.
 *
 * @param {string} id - learned_qa id
 * @returns {Promise<{ok: boolean, row?: object, reason?: string}>}
 */
async function embedApprovedById(id) {
  try {
    const row = await learnedQaRepo.findById(id);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'approved') return { ok: false, reason: 'not_approved' };
    if (row.embedding_id) return { ok: true, row, reason: 'already_embedded' };

    const updated = await embedRow(row);
    return { ok: true, row: updated || row };
  } catch (err) {
    console.error(`[EpisodicMemory] embedApprovedById failed for ${id}:`, err.message);
    return { ok: false, reason: 'embed_error' };
  }
}

module.exports = {
  promoteFromFeedback,
  fetchQaPair,
  embedApprovedCandidates,
  embedApprovedById,
  LEARNED_QA_SOURCE,
};
