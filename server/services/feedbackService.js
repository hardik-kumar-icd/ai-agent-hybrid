/**
 * feedbackService.js
 *
 * Business logic layer between the route handler and the DB repository.
 * Responsibilities:
 *   - Input validation (rating enum, tag list, comment length, UUID format)
 *   - Cross-table verification (messageId must exist + belong to conversationId)
 *   - Sanitization (trim strings, dedupe tags, drop unknown tags)
 *   - Always returns structured {ok, ...} for the route layer to map to HTTP status
 *
 * NEVER throws to the route layer — all errors are returned as {ok: false, error}.
 */

const feedbackRepo = require('../db/repositories/feedbackRepo');
const { query } = require('../db/index');

// Allowed tag values. Multi-select, only valid on rating='down'.
// Update this list to localize / extend. Each tag is sent verbatim from the
// widget so the strings here must match the widget's tag labels exactly.
const ALLOWED_TAGS_NB = [
  'Feil informasjon',
  'Ikke hjelpsomt',
  'For langt',
  'Mangler informasjon',
  'Feil språk',
  'Annet',
];

const ALLOWED_TAGS_EN = [
  'Incorrect info',
  'Not helpful',
  'Too long',
  'Missing information',
  'Wrong language',
  'Other',
];

const ALLOWED_TAGS = new Set([...ALLOWED_TAGS_NB, ...ALLOWED_TAGS_EN]);

const MAX_COMMENT_LENGTH = 500;
const MAX_TAGS_PER_FEEDBACK = 6;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a string looks like a UUID. Used for messageId + conversationId.
 */
function isValidUuid(s) {
  return typeof s === 'string' && UUID_REGEX.test(s);
}

/**
 * Verify that a message exists AND belongs to the given conversation.
 * Prevents tampering where someone tries to attach feedback to a message
 * they didn't see (cross-conversation manipulation).
 *
 * @returns {Promise<boolean>}
 */
async function verifyMessageInConversation(messageId, conversationId) {
  const result = await query(
    `SELECT 1 FROM messages
     WHERE id = $1 AND conversation_id = $2 AND role = 'assistant'
     LIMIT 1`,
    [messageId, conversationId]
  );
  return !!(result && result.rows.length > 0);
}

/**
 * Submit feedback for an assistant message.
 *
 * @param {object} input - parsed request body
 * @returns {Promise<{ok: boolean, error?: string, feedback?: object, is_update?: boolean}>}
 */
async function submitFeedback(input) {
  const { messageId, conversationId, rating, tags, comment } = input || {};

  // --- Validate UUIDs ---
  if (!isValidUuid(messageId)) {
    return { ok: false, error: 'invalid messageId' };
  }
  if (!isValidUuid(conversationId)) {
    return { ok: false, error: 'invalid conversationId' };
  }

  // --- Validate rating ---
  if (rating !== 'up' && rating !== 'down') {
    return { ok: false, error: 'rating must be "up" or "down"' };
  }

  // --- Validate tags ---
  let cleanTags = null;
  if (rating === 'down') {
    if (tags != null) {
      if (!Array.isArray(tags)) {
        return { ok: false, error: 'tags must be an array' };
      }
      // Filter out unknown/invalid tags, dedupe, cap to MAX_TAGS_PER_FEEDBACK
      const filtered = [];
      const seen = new Set();
      for (const t of tags) {
        if (typeof t !== 'string') continue;
        const trimmed = t.trim();
        if (!ALLOWED_TAGS.has(trimmed)) continue;  // silently drop unknown
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        filtered.push(trimmed);
        if (filtered.length >= MAX_TAGS_PER_FEEDBACK) break;
      }
      cleanTags = filtered.length > 0 ? filtered : null;
    }
  } else {
    // Thumbs-up: ignore any tags client sent (defensive)
    cleanTags = null;
  }

  // --- Validate comment ---
  let cleanComment = null;
  if (comment != null) {
    if (typeof comment !== 'string') {
      return { ok: false, error: 'comment must be a string' };
    }
    const trimmed = comment.trim();
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      return { ok: false, error: `comment exceeds ${MAX_COMMENT_LENGTH} chars` };
    }
    cleanComment = trimmed.length > 0 ? trimmed : null;
  }

  // --- Verify the message exists and belongs to the conversation ---
  const exists = await verifyMessageInConversation(messageId, conversationId);
  if (!exists) {
    return {
      ok: false,
      error: 'message not found or does not belong to conversation'
    };
  }

  // --- Upsert ---
  const row = await feedbackRepo.upsert({
    messageId,
    conversationId,
    rating,
    tags: cleanTags,
    comment: cleanComment,
  });

  if (!row) {
    return { ok: false, error: 'database error' };
  }

  return {
    ok: true,
    feedback: {
      message_id: row.message_id,
      rating: row.rating,
      tags: row.tags,
      comment: row.comment,
    },
    is_update: !row.is_insert,
  };
}

module.exports = {
  submitFeedback,
  ALLOWED_TAGS_NB,
  ALLOWED_TAGS_EN,
  MAX_COMMENT_LENGTH,
};
