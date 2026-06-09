/**
 * Telemetry service — fire-and-forget orchestrator.
 *
 * Single public entry point: logTurn() — called once per chat request, after
 * the response is fully streamed to the user. It records:
 *
 *   1. The user's question (as a 'user' message row)
 *   2. The assistant's reply (as an 'assistant' message row)
 *   3. The retrieval trace (chunks shown to the model)
 *   4. PII identifiers (email, order_id) into the hash table
 *
 * IMPORTANT: this never blocks. The caller wraps the call in
 * `setImmediate(() => telemetry.logTurn(...))` so even slow inserts don't
 * delay the SSE response close.
 *
 * Errors at any layer are logged but never thrown — telemetry must NEVER
 * break the chat path.
 */

const conversationsRepo = require('../db/repositories/conversations');
const messagesRepo = require('../db/repositories/messages');
//const retrievalsRepo = require('../db/repositories/retrievals');
const piiRepo = require('../db/repositories/piiIdentifiers');
const { redactPII } = require('./piiRedaction');

/**
 * Log a full chat turn (user message + assistant response + retrievals).
 *
 * @param {object} input
 * @param {string} input.conversationId   - public conversation_id (from widget)
 * @param {object} input.user             - user message details
 * @param {string} input.user.messageId   - pre-generated UUID for this user msg
 * @param {string} input.user.content     - raw user text (will be PII-redacted)
 * @param {string|null} input.user.email
 * @param {string|null} input.user.orderId
 * @param {string|null} input.user.language
 * @param {string|null} input.user.userAgent
 * @param {object} input.assistant         - assistant message details
 * @param {string} input.assistant.messageId  - SSE messageId for this reply
 * @param {string} input.assistant.content    - raw assistant text
 * @param {string|null} input.assistant.language
 * @param {string|null} input.assistant.path
 * @param {string|null} input.assistant.model
 * @param {boolean|null} input.assistant.embeddingCached
 * @param {number|null} input.assistant.latencyMs
 * @param {object} input.retrieval         - retrieval trace
 * @param {string|null} input.retrieval.query
 * @param {Array} input.retrieval.chunks   - [{chunk_id, source, score, text, rank}]
 */
async function logTurn(input) {
  try {
    const { conversationId, user, assistant, retrieval } = input;
    if (!conversationId || !user || !assistant) return;

    // ---- Step 1: hash PII (email + order_id) ----
    let userEmailHash = null;
    let userOrderHash = null;
    if (user.email) {
      userEmailHash = await piiRepo.recordIdentifier(user.email, 'email');
    }
    if (user.orderId) {
      userOrderHash = await piiRepo.recordIdentifier(user.orderId, 'order_id');
    }

    // ---- Step 2: find-or-create conversation ----
    const conv = await conversationsRepo.findOrCreate({
      conversationId,
      userEmailHash,
      userOrderHash,
      language: user.language || assistant.language,
      userAgent: user.userAgent,
    });
    if (!conv) return;  // DB unavailable — silently skip

    // ---- Step 3: insert user message ----
    await messagesRepo.insert({
      id: user.messageId,
      conversationId: conv.id,
      role: 'user',
      content: redactPII(user.content),
      language: user.language || null,
      path: null,           // user messages don't have a path
      model: null,
      toolCalls: null,
      embeddingCached: null,
      latencyMs: null,
      tokenCount: null,
    });

    // ---- Step 4: insert assistant message ----
    await messagesRepo.insert({
      id: assistant.messageId,
      conversationId: conv.id,
      role: 'assistant',
      content: redactPII(assistant.content),
      language: assistant.language || null,
      path: assistant.path || null,
      model: assistant.model || null,
      toolCalls: assistant.toolCalls || null,
      embeddingCached: assistant.embeddingCached || null,
      latencyMs: assistant.latencyMs || null,
      tokenCount: assistant.tokenCount || null,
    });
  } catch (err) {
    // Catch-all so telemetry NEVER throws back into the chat path
    console.error('[Telemetry] logTurn failed:', err.message);
  }
}

module.exports = {
  logTurn,
};
