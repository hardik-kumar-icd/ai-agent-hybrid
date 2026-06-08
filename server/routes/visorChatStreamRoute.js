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
const conversationsRepo = require('../db/repositories/conversations');
const { validateMessage } = require('../middlewares/validation');
const { sessionMiddleware } = require('../middlewares/session');
const { logApiRequest, logOrderLookup } = require('../utils/securityLogger');
const { getCacheStats } = require('../utils/embeddingCache');
const telemetry = require('../services/telemetryService');
const { getOrderStatusTool } = require('../tools/getOrderStatusTool');
const {
  formatOrderStatusNorwegian,
  formatOrderErrorNorwegian,
  streamTextAsTokens,
} = require('../utils/orderResponseFormatter');

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
      category: "string (optional) - 'faqs' | 'product' | 'order' | 'free'",
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

    // -----------------------------------------------------------------------
    // PR #15: Direct-dispatch fast path for category=order
    //
    // When the widget Order Status button is clicked (category='order') AND
    // both order_id + email are present, we skip the LLM router entirely and
    // call the Magento order tool directly. This:
    //   - Eliminates 1-2s of LLM router latency
    //   - Always returns live data (no stale cache)
    //   - Cannot misroute (LLM occasionally refused valid order queries)
    //
    // Falls through to the agent for: category!='order', missing order/email,
    // or to recover when extraction worked but category wasn't set explicitly.
    // -----------------------------------------------------------------------
    if (category === 'order' && finalOrderId && finalEmail) {
      const directStart = Date.now();
      let directText = '';
      let directOk = false;

      try {
        const orderData = await getOrderStatusTool({
          order_id: finalOrderId,
          email: finalEmail,
        });
        // orderData = { id, status, tracking, delivery_date }  (sanitized)
        directText = formatOrderStatusNorwegian(orderData);
        directOk = true;
      } catch (err) {
        directText = formatOrderErrorNorwegian(err);
        // directOk stays false — telemetry will record this as a failed direct dispatch
      }

      // Stream the response token-by-token so the customer experience matches LLM output
      await streamTextAsTokens(res, directText, sendSse, flush);

      _assistantContent = directText;
      const directDuration = Date.now() - directStart;

      if (req.session.appendToHistory) {
        req.session.appendToHistory('user', message);
        req.session.appendToHistory('assistant', directText);
      }

      sendSse(res, {
        type: 'done',
        content: directText,
        messageId: assistantMessageId,
        path: 'order_direct',
        durationMs: directDuration,
      });
      flush(res);

      console.log(`[Stream] path=order_direct ok=${directOk} duration=${directDuration}ms messageId=${assistantMessageId}`);

      // Telemetry — log this as a direct-dispatch turn
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
            path: 'order_direct',
            model: null,                                          // no LLM was called
            toolCalls: ['get_order_status'],
            embeddingCached: null,
            latencyMs: directDuration,
            tokenCount: null,
          },
          retrieval: {
            query: null,                                          // no RAG retrieval
            chunks: [],
          },
        }).catch((err) => {
          console.error('[Telemetry] async failure (order_direct):', err?.message);
        });
      });

      clearInterval(heartbeat);
      res.end();
      return;
    }
    // -----------------------------------------------------------------------
    // End PR #15 direct-dispatch block.
    // Below: existing flow unchanged (LLM-driven via processVisorMessageStream).
    // -----------------------------------------------------------------------

    let enhancedMessage = message;
    if (finalOrderId || finalEmail) {
      const ctx = [];
      if (finalOrderId) ctx.push(`Order ID: ${finalOrderId}`);
      if (finalEmail) ctx.push(`Email: ${finalEmail}`);
      enhancedMessage = `${message}\n\n[Context: ${ctx.join(', ')}]`;
    }

    const history = req.session.getHistory ? req.session.getHistory() : [];

    const startTime = Date.now();

    // Drop 4-light v2 — resolve conversation UUID up-front so the agent
    // can record retrieval telemetry against it. Same idempotent call used
    // by telemetry.logTurn after the turn completes.
    let dbConversationId = null;
    try {
      const widgetConvId = req.body.conversationId || req.headers['x-conversation-id'] || null;
      if (widgetConvId) {
        const conv = await conversationsRepo.findOrCreate({
          conversationId: widgetConvId,
          language: _language,
          userAgent: req.headers['user-agent'],
        });
        if (conv && conv.id) dbConversationId = conv.id;
      }
    } catch (e) {
      console.warn('[stream] conversation resolution failed:', e?.message);
      // Continue without telemetry rather than failing the request
    }

    const fullText = await processVisorMessageStream(
      enhancedMessage,
      history,
      (token) => {
        sendSse(res, { type: 'token', content: token });
        flush(res);
      },
      { category: category || 'free',
        assistantMessageId,
        dbConversationId, },
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
