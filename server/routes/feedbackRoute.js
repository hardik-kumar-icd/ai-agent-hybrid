/**
 * feedbackRoute.js
 *
 * POST /api/feedback — Customer feedback submission endpoint.
 *
 * Drop 3 (Feedback UI). Customers click 👍/👎 below assistant messages in the
 * widget; the widget POSTs here with messageId, rating, optional tags, optional
 * comment. The endpoint validates and upserts to the message_feedback table.
 *
 * Request body:
 *   {
 *     messageId:      "uuid",       // from SSE meta event
 *     conversationId: "uuid",       // from local widget state
 *     rating:         "up" | "down",
 *     tags:           ["Feil informasjon", ...] | null,   // multi-select, down only
 *     comment:        "string" | null                     // <=500 chars
 *   }
 *
 * Responses:
 *   200 { ok: true, feedback: {...}, is_update: false }   - new feedback
 *   200 { ok: true, feedback: {...}, is_update: true  }   - existing feedback updated
 *   400 { ok: false, error: "..." }                       - validation failure
 *   500 { ok: false, error: "..." }                       - server/DB error
 *
 * No authentication required — anyone with a valid messageId can submit.
 * Anti-tampering: feedbackService verifies the messageId actually belongs to
 * the claimed conversationId, so customers can't submit feedback for
 * messages they didn't see.
 *
 * Rate limiting: relies on the global rate limiter already attached at the
 * Express app level. No per-endpoint limit added in this PR.
 */

const express = require('express');
const router = express.Router();
const feedbackService = require('../services/feedbackService');

router.post('/', async (req, res) => {
  try {
    const result = await feedbackService.submitFeedback(req.body);

    if (!result.ok) {
      // Validation failures are 400; DB failures are 500
      const isDbError = (result.error || '').toLowerCase().includes('database');
      const status = isDbError ? 500 : 400;
      return res.status(status).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[feedback] Unexpected error:', err?.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// GET /api/feedback?messageId=... - read current feedback (used by widget on
// reconnect or by admin dashboard later). No auth in this PR.
router.get('/', async (req, res) => {
  try {
    const { messageId } = req.query;
    if (!messageId) {
      return res.status(400).json({ ok: false, error: 'messageId required' });
    }
    const feedbackRepo = require('../db/repositories/feedbackRepo');
    const row = await feedbackRepo.getByMessageId(messageId);
    if (!row) {
      return res.status(200).json({ ok: true, feedback: null });
    }
    return res.status(200).json({
      ok: true,
      feedback: {
        message_id: row.message_id,
        rating: row.rating,
        tags: row.tags,
        comment: row.comment,
      },
    });
  } catch (err) {
    console.error('[feedback GET] Unexpected error:', err?.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

module.exports = router;
