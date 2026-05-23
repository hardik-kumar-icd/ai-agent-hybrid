/**
 * Streaming Visor chat endpoint.
 *
 * Mounted at: POST /visor-chat/stream
 *
 * Why a separate endpoint?
 *  - Backward compatibility: the existing /visor-chat keeps working unchanged.
 *  - The widget tries this endpoint first and falls back to /visor-chat if
 *    streaming fails for any reason (CSP, proxy buffering, old build).
 *
 * Protocol: Server-Sent Events (SSE).
 *
 * Events the client receives:
 *   data: {"type":"meta","messageId":"..."}   sent once at the start
 *   data: {"type":"token","content":"..."}    sent for each token
 *   data: {"type":"done","content":"FULL"}    sent when complete
 *   data: {"type":"error","message":"..."}    sent on error
 *
 * Each event is terminated with a blank line (standard SSE format).
 */

const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { processVisorMessageStream } = require('../agents/visorAgentStream');
const { validateMessage } = require('../middlewares/validation');
const { sessionMiddleware } = require('../middlewares/session');
const { logApiRequest, logOrderLookup, maskEmail, maskOrderId } = require('../utils/securityLogger');

// Reuse the same regex helpers as the non-streaming route
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

// SSE helpers ---------------------------------------------------------------
function sendSse(res, payload) {
  // Each SSE event: "data: <json>\n\n"
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Encourage flushing through Nginx (we also set proxy_buffering off in nginx)
function flush(res) {
  if (typeof res.flush === 'function') {
    try { res.flush(); } catch (_) { /* ignore */ }
  }
}

// GET handler — info
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
  });
});

// POST /visor-chat/stream
router.post('/', sessionMiddleware, validateMessage, async (req, res) => {
  const messageId = randomUUID();

  // ---- SSE headers ----
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Tell Nginx: do not buffer
  // CORS — match the global CORS config but be explicit for SSE
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');

  // Flush headers immediately so the client opens the stream
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // Heartbeat keeps proxies from killing the connection during long thinking
  const heartbeat = setInterval(() => {
    try {
      res.write(': hb\n\n');
      flush(res);
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 15000);

  // Detach heartbeat when the connection closes
  req.on('close', () => clearInterval(heartbeat));

  try {
    const { message, email, order_id } = req.body;
    logApiRequest(req, '/visor-chat/stream');

    // Send meta event with messageId (foundation for feedback in Drop 4)
    sendSse(res, { type: 'meta', messageId });
    flush(res);

    // Order/email plumbing — identical to /visor-chat
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

    // Stream the agent's tokens to the client
    const fullText = await processVisorMessageStream(
      enhancedMessage,
      history,
      (token) => {
        sendSse(res, { type: 'token', content: token });
        flush(res);
      },
    );

    // Persist to session for next turn's context
    if (req.session.appendToHistory) {
      req.session.appendToHistory('user', enhancedMessage);
      req.session.appendToHistory('assistant', fullText);
    }

    // Final event with full text (so the client can store it cleanly)
    sendSse(res, { type: 'done', content: fullText, messageId });
    flush(res);
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
