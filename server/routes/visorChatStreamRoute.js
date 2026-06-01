/**
 * visorChatStreamRoute.js  (updated for Drop 1 — telemetry)
 *
 * Changes vs. previous version (FAQ fast-path PR):
 *   - Pre-generates a `userMessageId` AND `assistantMessageId` (UUIDs) at the
 *     start of each request, includes both in the meta event
 *   - After the SSE response completes, fires telemetry.logTurn() to persist
 *     the conversation, both messages, and the retrieval trace to Postgres
 *   - Telemetry is wrapped in setImmediate so it never delays the chat response
 *
 * Drop 2 update: extracts `category` from request body and passes it
 * through to the agent so the system prompt can be biased per widget entry-point.
 *
 * Drop-in replacement for server/routes/visorChatStreamRoute.js
 */

const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const {
  processVisorMessageStream,
  getLastExecutionPath,
  getLastRetrievalTrace,
} = require('../agents/visorAgentStream');
const { validateMessage } = require('../middlewares/validation');
const { sessionMiddleware } = require('../middlewares/session');
const { logApiRequest, logOrderLookup } = require('../utils/securityLogger');
const { getCacheStats } = require('../utils/embeddingCache');
const telemetry = require('../services/telemetryService');

// ---- Order/email extraction helpers (unchanged) ----
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

function detectLanguage(message) {
  if (!message) return null;
  if (/[æøå]/i.test(message)) return 'nb';
  if (/\b(hva|hvor|hvordan|når|hvilke|er|har|vi|du|jeg)\b/i.test(message)) return 'nb';
  return 'en';
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function flush(res) {
  if (typeof res.flush === 'function') {
    try { res.flush(); } catch (_) { /* ignore */ }
  }
}

// ---- GET handlers ----
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
      category: "string (optional) - 'faqs' | 'product' | 'free'",
    },
    events: ['meta', 'token', 'done', 'error'],
    note: 'Falls back to /visor-chat if streaming is not supported.',
    embedding_cache: getCacheStats(),
  });
});

router.get('/stats', (req, res) => {
  res.json({
    embedding_cache: getCacheStats(),
  });
});

// ---- POST handler ----
router.post('/', sessionMiddleware, validateMessage, async (req, res) => {
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');

  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(': hb\n\n'); flush(res); } catch (_) { clearInterval(heartbeat); }
  }, 15000);
  req.on('close', () => clearInterval(heartbeat));

  let _userContent = '';
  let _assistantContent = '';
  let _email = null;
  let _orderId = null;
  let _language = null;

  try {
    const { message, email, order_id, category } = req.body;
    logApiRequest(req, '/visor-chat/stream');

    sendSse(res, { type: 'meta', messageId: assistantMessageId, path: 'pending' });
    flush(res);

    const extractedOrderId = extractOrderIdFromMessage(message);
    const extractedEmail = extractEmailFromMessage(message);
    const sessionData = req.session.get();

    const finalOrderId = order_id || extractedOrderId || sessionData?.order_id || null;
    const finalEmail = email || extractedEmail || sessionData?.email || null;

    _userContent = message;
    _email = finalEmail;
    _orderId = finalOrderId;
    _language = detectLanguage(message);

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
      { category: category || 'free' },
    );
    const durationMs = Date.now() - startTime;
    const path = getLastExecutionPath();
    const trace = getLastRetrievalTrace();
    _assistantContent = fullText;

    if (req.session.appendToHistory) {
      req.session.appendToHistory('user', enhancedMessage);
      req.session.appendToHistory('assistant', fullText);
    }

    sendSse(res, {
      type: 'done',
      content: fullText,
      messageId: assistantMessageId,
      path,
      durationMs,
    });
    flush(res);

    console.log(`[Stream] path=${path} duration=${durationMs}ms messageId=${assistantMessageId} category=${category || 'free'}`);

    setImmediate(() => {
      telemetry.logTurn({
        conversationId: req.body.conversationId || req.headers['x-conversation-id'] || null,
        user: {
          messageId: userMessageId,
          content: _userContent,
          email: _email,
          orderId: _orderId,
          language: _language,
          userAgent: req.headers['user-agent'] || null,
        },
        assistant: {
          messageId: assistantMessageId,
          content: _assistantContent,
          language: _language,
          path,
          model: trace?.modelUsed || null,
          toolCalls: trace?.toolCalls?.length > 0 ? trace.toolCalls : null,
          embeddingCached: trace?.cacheHit || false,
          latencyMs: durationMs,
          tokenCount: null,
        },
        retrieval: {
          query: trace?.searchQuery || null,
          chunks: trace?.docs || [],
        },
      }).catch((err) => {
        console.error('[Telemetry] async failure:', err?.message);
      });
    });
  } catch (err) {
    console.error('[Visor Stream] error:', err);
    try {
      sendSse(res, { type: 'error', message: err.message || 'Internal error', messageId: assistantMessageId });
    } catch (_) { /* ignore */ }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

module.exports = router;
