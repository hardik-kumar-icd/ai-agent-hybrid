/**
 * adminRoute.js
 *
 * Drop 5 (minimal) — protected admin endpoints for browsing collected data:
 *   GET /api/admin/overview                  - summary counts for dashboard landing
 *   GET /api/admin/conversations             - paginated list with filters
 *   GET /api/admin/conversations/:id         - single conversation + messages + feedback
 *   GET /api/admin/feedback                  - paginated feedback list with joined context
 *
 * All endpoints protected by requireAdminAuth (Bearer ADMIN_API_KEY).
 *
 * The :id parameter in conversations/:id is the internal UUID (`conversations.id`),
 * NOT the external widget conversation_id text. The conversations list endpoint
 * returns both so the UI can use the correct one.
 */

const express = require('express');
const router = express.Router();
const { requireAdminAuth } = require('../middlewares/auth');
const adminRepo = require('../db/repositories/adminRepo');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// All routes below this line require admin auth
router.use(requireAdminAuth);

// ----------------------------------------------------------------------------
// GET /api/admin/overview — summary counts
// ----------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const stats = await adminRepo.getOverviewStats();
    if (!stats) {
      return res.status(500).json({ ok: false, error: 'database error' });
    }
    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    console.error('[admin/overview] error:', err?.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ----------------------------------------------------------------------------
// GET /api/admin/conversations
// Query params:
//   limit         (default 20, max 100)
//   offset        (default 0)
//   since         (ISO date, optional)
//   has_feedback  ("true"/"false", optional)
//   rating        ("up"/"down", optional, only meaningful with has_feedback=true)
// ----------------------------------------------------------------------------
router.get('/conversations', async (req, res) => {
  try {
    const result = await adminRepo.listConversations({
      limit: req.query.limit,
      offset: req.query.offset,
      since: req.query.since,
      hasFeedback: req.query.has_feedback === 'true',
      rating: req.query.rating,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin/conversations] error:', err?.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ----------------------------------------------------------------------------
// GET /api/admin/conversations/:id  (UUID required)
// ----------------------------------------------------------------------------
router.get('/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid conversation id' });
    }
    const detail = await adminRepo.getConversationDetail(id);
    if (!detail) {
      return res.status(404).json({ ok: false, error: 'conversation not found' });
    }
    return res.status(200).json({ ok: true, ...detail });
  } catch (err) {
    console.error('[admin/conversations/:id] error:', err?.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ----------------------------------------------------------------------------
// GET /api/admin/feedback
// Query params:
//   limit         (default 20, max 100)
//   offset        (default 0)
//   rating        ("up"/"down", optional — defaults to all)
//   since         (ISO date, optional)
// ----------------------------------------------------------------------------
router.get('/feedback', async (req, res) => {
  try {
    const result = await adminRepo.listFeedback({
      limit: req.query.limit,
      offset: req.query.offset,
      rating: req.query.rating,
      since: req.query.since,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin/feedback] error:', err?.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

module.exports = router;
