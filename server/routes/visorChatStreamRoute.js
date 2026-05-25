/**
 * visorChatStreamRoute.js  (updated for FAQ fast-path PR)
 *
 * Changes vs. the latency PR version:
 *   - Meta event now includes `path` field showing which execution path ran
 *     ('fast' | 'complex' | 'order') for debugging in DevTools
 *   - Adds cache stats endpoint at GET /visor-chat/stream/stats
 *
 * Drop-in replacement for server/routes/visorChatStreamRoute.js
 */

const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { processVisorMessageStream, getLastExecutionPath } = require('../agents/visorAgentStream');
const { validateMessage } = require('../middlewares/validation');
const { sessionMiddleware } = require('../middlewares/session');
const { logApiRequest, logOrderLookup, maskEmail, maskOrderId } = require('../utils/securityLogger');
const { getCacheStats } = require('../utils/embeddingCache');

function extractOrderIdFromMessage(message) {
  if (!message || typeof message !== 'string') return null;
  const patterns = [
    /order\s*#?\s*(\d+)/i,
    /ordre\s*#?\s*(\d+)/i,
    /#(\d+)/,
    /order_id\s*:\s*(\d+)/i,
    /order\s+(\d+)/i,
    /ordre\s+(\d+)/i,
    /\b(\d{4,})\b/,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

function extractEmailFromMessage(message) {
  if (!message || typeof message !== 'string') return null;
  const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
  const m = message.match(emailPattern);
  return m ? m[0] : null;
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function flush(res) {
  if (typeof res.flush === 'function') {
    try { res.flush(); } catch (_) { /* ignore */ }
  }
}

// GET handler — info + cache stats
router.get('/', (req, res) => {
  res.json({
    message: 'Visor.no AI Agent streaming endpoint',
    method: 'POST',
    endpoint: '/visor-chat/stream',
    contentType: 'text/event-stream',
    body: {
      message: 'string (required)',
      email: 'string (optional)',
      order_id: 'string (optional)',
      conversationId: 'string (optional)',
    },
    events: ['meta', 'token', 'done', 'error'],
    note: 'Falls back to /visor-chat if streaming is not supported.',
    embedding_cache: getCacheStats(),
  });
});

// GET stats — cache + path metrics (handy for tuning)
router.get('/stats', (req, res) => {
  res.json({
    embedding_cache: getCacheStats(),
  });
});

// POST /visor-chat/stream
router.post('/', sessionMiddleware, validateMessage, async (req, res) => {
  const messageId = randomUUID();

  // ---- SSE headers ----
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // Heartbeat to keep proxies happy during long thinking
  const heartbeat = setInterval(() => {
    try {
      res.write(': hb\n\n');
      flush(res);
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => clearInterval(heartbeat));

  try {
    const { message, email, order_id } = req.body;
    logApiRequest(req, '/visor-chat/stream');

    // Send initial meta — path is unknown yet, will be confirmed in done event
    sendSse(res, { type: 'meta', messageId, path: 'pending' });
    flush(res);

    const extractedOrderId = extractOrderIdFromMessage(message);
    const extractedEmail = extractEmailFromMessage(message);
    const sessionData = req.session.get();

    const finalOrderId = order_id || extractedOrderId || sessionData?.order_id || null;
    const finalEmail = email || extractedEmail || sessionData?.email || null;

    if (finalOrderId || finalEmail) {
      req.session.update({
        order_id: finalOrderId || undefined,
        email: finalEmail || undefined,
      });
    }
    if (finalOrderId && finalEmail) {
      logOrderLookup(finalOrderId, finalEmail, '[Visor Stream] Order lookup');
    }

    let enhancedMessage = message;
    if (finalOrderId || finalEmail) {
      const ctx = [];
      if (finalOrderId) ctx.push(`Order ID: ${finalOrderId}`);
      if (finalEmail) ctx.push(`Email: ${finalEmail}`);
      enhancedMessage = `${message}\n\n[Context: ${ctx.join(', ')}]`;
    }

    const history = req.session.getHistory ? req.session.getHistory() : [];

    const startTime = Date.now();
    const fullText = await processVisorMessageStream(
      enhancedMessage,
      history,
      (token) => {
        sendSse(res, { type: 'token', content: token });
        flush(res);
      },
    );
    const durationMs = Date.now() - startTime;
    const path = getLastExecutionPath();

    // Persist to session for next turn
    if (req.session.appendToHistory) {
      req.session.appendToHistory('user', enhancedMessage);
      req.session.appendToHistory('assistant', fullText);
    }

    // Final event includes path + duration for debugging
    sendSse(res, {
      type: 'done',
      content: fullText,
      messageId,
      path,
      durationMs,
    });
    flush(res);

    // Log path + duration server-side too (useful for tuning the classifier)
    console.log(`[Stream] path=${path} duration=${durationMs}ms messageId=${messageId}`);
  } catch (err) {
    console.error('[Visor Stream] error:', err);
    try {
      sendSse(res, { type: 'error', message: err.message || 'Internal error', messageId });
    } catch (_) { /* ignore */ }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

module.exports = router;
