/**
 * visorAgentStream.js  (updated for Drop 1 — intelligence foundations)
 *
 * Changes vs. previous version (brevity PR):
 *   - Tracks the full retrieval trace (chunks used, model, cache hit, etc.)
 *     in a closure variable and exposes it via getLastRetrievalTrace()
 *   - Trace is reset at the start of every request and populated as the
 *     agent does its work
 *   - No change to user-visible behavior
 *
 * Drop-in replacement for server/agents/visorAgentStream.js
 */

const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
const { searchSimilar, searchSimilarFiltered } = require('../utils/embeddingService');
const { searchTickets } = require('../utils/ticketSearch');
const { classifyQuery } = require('../utils/queryClassifier');
const { getCachedEmbedding } = require('../utils/embeddingCache');
const getOrderDetailsTool = require('../tools/getOrderDetailsTool');
const getOrderStatusTool = require('../tools/getOrderStatusTool');

const {
  hasSubstantiveKbContext,
  isSensitivePolicyQuery,
  reRankByKeywordOverlap,
  sanitizeTicketText,
  getSystemPrompt,
  getToolDefinitions,
} = require('./visorAgentShared');

const retrievalsRepo = require('../db/repositories/retrievalsRepo');

const FAST_PATH_MAX_TOKENS = 250;
const COMPLEX_PATH_MAX_TOKENS = 500;

// Per-source confidence floors. Below these scores, retrieval returns
// NO_KNOWLEDGE_BASE_DATA instead of weak chunks the agent might synthesize from.
// Env-tunable without redeploy. See DROP2_FINAL_DESIGN.md.
const CONFIDENCE_FLOORS = {
  visor_faqs: parseFloat(process.env.RAG_FLOOR_FAQ || '0.55'),
  visor_products: parseFloat(process.env.RAG_FLOOR_PRODUCTS || '0.50'),
  visor_tickets: parseFloat(process.env.RAG_FLOOR_TICKETS || '0.45'),
  'tickets_fixed.jsonl': parseFloat(process.env.RAG_FLOOR_TICKETS || '0.45'),
  learned_qa: parseFloat(process.env.RAG_FLOOR_LEARNED || '0.72'),
};

const SOURCE_LABELS = {
  visor_faqs: 'FAQ',
  visor_products: 'Product catalog',
  visor_tickets: 'Support ticket history',
  'tickets_fixed.jsonl': 'Support ticket history',
};

// A learned_qa answer reflects a customer's satisfaction at approval time,
// not an ongoing guarantee the underlying policy/info hasn't changed since.
// Past this age it's still used as a candidate the LLM weighs against fresh
// KB results (see routeOpts.learnedQa), but it no longer bypasses the LLM
// entirely via the high-confidence SHORT-CIRCUIT — an old answer silently
// short-circuiting forever was the highest-risk staleness gap found in the
// retrieval-quality review.
const LEARNED_QA_STALE_DAYS = parseFloat(process.env.LEARNED_QA_STALE_DAYS || '180');

// ---------------------------------------------------------------------------
// Trace state — populated during a single request, returned afterwards.
// Note: this is closure-shared (not request-scoped) because Node's PM2 fork
// mode runs one request at a time within a single worker. If we ever go
// cluster mode we'll need to use AsyncLocalStorage.
// ---------------------------------------------------------------------------
let _lastPath = 'complex';
let _lastTrace = null;

function resetTrace() {
  _lastTrace = {
    docs: [],         // [{chunk_id, source, score, text, rank}]
    searchQuery: null,
    modelUsed: null,
    cacheHit: false,
    toolCalls: [],
  };
}

function getLastExecutionPath() {
  return _lastPath;
}

function getLastRetrievalTrace() {
  return _lastTrace;
}

// ---------------------------------------------------------------------------
// Conservative model picker
// ---------------------------------------------------------------------------
function pickFastPathModel(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return 'gpt-4o-mini';
  if (docs.length >= 3) return 'gpt-4o';
  const productDocCount = docs.filter((d) => {
    const src = (d.source || '').toLowerCase();
    const txt = (d.text || '').toLowerCase();
    if (src.includes('product')) return true;
    if (/\b(price|pris|sku|max.?(width|bredde)|systemb)/i.test(txt)) return true;
    return false;
  }).length;
  // Escalate to the full model only when multiple product docs are in play
  // (a comparison-style question benefits from more careful synthesis). A
  // single product doc is a simple fact lookup ("what's the price of X?")
  // that gpt-4o-mini handles fine — and product questions are common enough
  // that escalating on every single one defeats the point of the fast path.
  if (productDocCount >= 2) return 'gpt-4o';
  return 'gpt-4o-mini';
}

/**
 * Search a single source and apply its confidence floor.
 */
const KEYWORD_RESCUE_SOURCES = new Set(['visor_products']);

/**
 * Keyword rescue for short term / SKU queries.
 *
 * A short, distinctive query (a product name, a feature like "Cordlock", or a
 * SKU like "PLC20-E") dilutes against long product chunks, so cosine can land
 * below the confidence floor even though the product is a correct match. When a
 * distinctive query token appears verbatim in a result we treat that result as
 * a confident match regardless of score.
 *
* False-positive guard:
 *   - distinctive token = length >= 5, OR length >= 4 containing a digit (SKU-like),
 *     which filters out short filler. A distinctive queried term legitimately
 *     appearing across several products SHOULD surface them all (capped at 5).
 * Returns [] when nothing distinctive matches, so genuine "not found" still deflects.
 */
function findKeywordRescueDocs(docs, query) {
  if (!Array.isArray(docs) || docs.length === 0 || !query) return [];
  const tokens = String(query).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 5 || (t.length >= 4 && /\d/.test(t)));
  if (tokens.length === 0) return [];

  const matched = docs.filter((d) => {
    const text = String(d && d.text || '').toLowerCase();
    return tokens.some((tok) => text.includes(tok));
  });
  return matched.slice(0, 5);
}

async function searchSourceWithFloor(query, sourceName, topK = 10) {
  const docs = await searchSimilarFiltered(query, sourceName, topK);
  if (!docs || docs.length === 0) {
    return { docs: [], belowFloor: true, bestScore: 0 };
  }
  const reranked = reRankByKeywordOverlap(docs, query);
  const bestScore = reranked[0]?.score || 0;
  const floor = CONFIDENCE_FLOORS[sourceName] ?? 0.55;
  if (bestScore < floor) {
    if (KEYWORD_RESCUE_SOURCES.has(sourceName)) {
      const rescued = findKeywordRescueDocs(reranked, query);
      if (rescued.length > 0) {
        console.log(`[search:${sourceName}] KEYWORD_RESCUE best=${bestScore.toFixed(3)} floor=${floor.toFixed(2)} rescued=${rescued.length}`);
        return { docs: rescued, belowFloor: false, bestScore };
      }
    }
    console.log(`[search:${sourceName}] LOW_CONFIDENCE best=${bestScore.toFixed(3)} floor=${floor.toFixed(2)}`);
    return { docs: reranked, belowFloor: true, bestScore };
  }
  return { docs: reranked, belowFloor: false, bestScore };
}

/**
 * Fast-path retrieval — picks best source automatically, optionally biased by category hint.
 */
async function ragRetrieve(query, opts = {}) {
  const cacheHitBefore = getCachedEmbedding(query) !== null;
  const topK = 10;

  const sourceByCategory = { faqs: 'visor_faqs', product: 'visor_products' };
  const preferredSource = sourceByCategory[opts.category];

  let mergedDocs = [];

  if (preferredSource) {
    const { docs, belowFloor } = await searchSourceWithFloor(query, preferredSource, topK);
    if (!belowFloor && docs.length > 0) {
      mergedDocs = docs;
    }
  }

  if (mergedDocs.length === 0) {
    const [faqResult, productResult, ticketResult] = await Promise.all([
      searchSourceWithFloor(query, 'visor_faqs', topK).catch((e) => {
        console.error('[ragRetrieve] FAQ search error:', e.message);
        return { docs: [], belowFloor: true, bestScore: 0 };
      }),
      searchSourceWithFloor(query, 'visor_products', topK).catch((e) => {
        console.error('[ragRetrieve] Products search error:', e.message);
        return { docs: [], belowFloor: true, bestScore: 0 };
      }),
      searchTickets(query, topK).then((rawDocs) => {
        if (!rawDocs || rawDocs.length === 0) {
          return { docs: [], belowFloor: true, bestScore: 0 };
        }
        const reranked = reRankByKeywordOverlap(rawDocs, query);
        const ticketSource = reranked[0]?.source || 'visor_tickets';
        const floor = CONFIDENCE_FLOORS[ticketSource] ?? 0.55;
        const bestScore = reranked[0]?.score || 0;
        return { docs: reranked, belowFloor: bestScore < floor, bestScore };
      }).catch((e) => {
        console.error('[ragRetrieve] Tickets search error:', e.message);
        return { docs: [], belowFloor: true, bestScore: 0 };
      }),
    ]);

    if (!faqResult.belowFloor) mergedDocs.push(...faqResult.docs);
    if (!productResult.belowFloor) mergedDocs.push(...productResult.docs);
    if (!ticketResult.belowFloor) mergedDocs.push(...ticketResult.docs);

    mergedDocs.sort((a, b) => (b.score || 0) - (a.score || 0));
    mergedDocs = mergedDocs.slice(0, topK);
  }

  // Drop 4 final (hybrid): blend the orchestrator's pre-fetched learned_qa hit
  // into the ranked KB results with a validation boost, so a human-approved
  // answer competes by score rather than auto-overriding a better KB match.
  const lq = opts.learnedQa;
  if (lq && lq.answer && (lq.score || 0) > 0) {
    const boost = parseFloat(process.env.RAG_LEARNED_BOOST || '0.10');
    mergedDocs.push({
      source: 'learned_qa',
      chunkId: 'learned_qa',
      text: `Previously validated answer (admin-approved): ${lq.answer}`,
      score: (lq.score || 0) + boost,
    });
    mergedDocs.sort((a, b) => (b.score || 0) - (a.score || 0));
    mergedDocs = mergedDocs.slice(0, topK);
  }

  if (_lastTrace) {
    _lastTrace.searchQuery = query;
    _lastTrace.cacheHit = cacheHitBefore;
    _lastTrace.docs = mergedDocs.map((d, idx) => ({
      chunk_id: d.chunkId || d.chunk_id || null,
      source: d.source || null,
      score: d.score || null,
      text: d.text || '',
      rank: idx + 1,
    }));
  }

  return mergedDocs;
}

/**
 * Search one source for the typed-tool handlers (complex path).
 */
     async function runTypedSearch(query, sourceName, userMessage, telemetryIds = null) {
      const { docs, belowFloor } = await searchSourceWithFloor(query, sourceName, 10);
       const bestScore = docs.length > 0 ? (docs[0].score || 0) : 0;
       const floor = CONFIDENCE_FLOORS[sourceName] ?? null;

       // Drop 4-light v2 — fire-and-forget telemetry. Never blocks the chat path.
      if (telemetryIds && telemetryIds.messageId && telemetryIds.conversationId) {
         setImmediate(() => {
          retrievalsRepo.insert({
            messageId: telemetryIds.messageId,
              conversationId: telemetryIds.conversationId,
             source: sourceName,
             queryText: query,
             topMatchId: docs[0]?.chunkId || null,
             topMatchScore: bestScore,
             topMatchText: docs[0]?.text || null,
             resultCount: docs.length,
             floor,
             passedFloor: !belowFloor && docs.length > 0,
           }).catch((e) => console.warn('[retrievals] insert failed:', e?.message));
         });
       }

       if (belowFloor || docs.length === 0) {
         return `NO_KNOWLEDGE_BASE_DATA: No reliable matches in ${SOURCE_LABELS[sourceName] || sourceName} for this query. Do NOT invent information.`;
       }

       if (_lastTrace) {
         _lastTrace.docs.push(...docs.map((d, idx) => ({
           chunk_id: d.chunkId || null,
           source: d.source || sourceName,
           score: d.score || null,
           text: d.text || '',
           rank: idx + 1,
         })));
       }

       const context = docs
         .map((d, idx) => `[Context ${idx + 1} from ${d.source}]: ${d.text}`)
         .join('\n\n');

       if (!hasSubstantiveKbContext(context)) {
         const sensitive = isSensitivePolicyQuery(userMessage);
         if (!sensitive) {
           return `NO_KNOWLEDGE_BASE_DATA: Top matches in ${SOURCE_LABELS[sourceName] || sourceName} are generic and don't answer this query directly.`;
         }
       }

       return context;
     }
/**
 * Search the learned_qa source (validated, admin-approved Q&A). We embed the
 * QUESTION, so the matched text is a past question and the validated answer is
 * in metadata.answer. Basic surfacing only — hybrid blending is Drop 4 final.
 */
async function runLearnedQaSearch(query, telemetryIds = null) {
  let docs = [];
  try {
    docs = await searchSimilarFiltered(query, 'learned_qa', 3);
  } catch (e) {
    console.error('[search:learned_qa] error:', e.message);
    docs = [];
  }

  const top = docs[0] || null;
  const bestScore = top?.score || 0;
  const floor = CONFIDENCE_FLOORS['learned_qa'] ?? 0.82;
  const passed = !!top && bestScore >= floor;

  // Drop 4-light v2 telemetry — fire-and-forget. Never blocks the chat path.
  if (telemetryIds && telemetryIds.messageId && telemetryIds.conversationId) {
    setImmediate(() => {
      retrievalsRepo.insert({
        messageId: telemetryIds.messageId,
        conversationId: telemetryIds.conversationId,
        source: 'learned_qa',
        queryText: query,
        topMatchId: top?.chunkId || null,
        topMatchScore: bestScore,
        topMatchText: top?.text || null,   // matched past question
        resultCount: docs.length,
        floor,
        passedFloor: passed,
      }).catch((e) => console.warn('[retrievals] insert failed:', e?.message));
    });
  }

  const answer = passed ? (top.metadata?.answer || '') : '';
  if (!passed || !answer) {
    console.log(`[search:learned_qa] ${top ? `LOW_CONFIDENCE best=${bestScore.toFixed(3)} floor=${floor.toFixed(2)}` : 'NO_MATCH'}`);
    return { passed: false, score: bestScore, answer: '' };
  }

  if (_lastTrace) {
    _lastTrace.docs.push({
      chunk_id: top.chunkId || null,
      source: 'learned_qa',
      score: bestScore,
      text: top.text || '',
      rank: 1,
    });
  }

  // Entries embedded before this metadata field existed have no approved_at —
  // treat those as stale too (conservative default) rather than assuming
  // they're fresh, since we have no actual evidence either way.
  const approvedAtMs = typeof top.metadata?.approved_at === 'number' ? top.metadata.approved_at : null;
  const ageDays = approvedAtMs !== null ? (Date.now() - approvedAtMs) / (24 * 60 * 60 * 1000) : Infinity;
  const isStale = ageDays > LEARNED_QA_STALE_DAYS;

  console.log(`[search:learned_qa] HIT best=${bestScore.toFixed(3)} floor=${floor.toFixed(2)} ageDays=${Number.isFinite(ageDays) ? ageDays.toFixed(0) : 'unknown'} stale=${isStale}`);
  return { passed: true, score: bestScore, answer, isStale };
}

function docsToContext(docs) {
  return docs
    .map((doc, idx) => `[Context ${idx + 1} from ${doc.source}]: ${doc.text}`)
    .join('\n\n');
}

async function ragToolFast({ query }) {
  try {
    const docs = await ragRetrieve(query);
    const context = docsToContext(docs);
    if (!context || context.trim().length === 0) {
      return 'NO_KNOWLEDGE_BASE_DATA: The knowledge base is empty or contains no relevant information. Do NOT make up products or use training data.';
    }
    return context;
  } catch (error) {
    console.error('[RAG Tool Stream] Error:', error);
    return `Error searching knowledge base: ${error.message}`;
  }
}

async function answerFromTicketsFast(userMessage) {
  const ticketDocs = await searchTickets(userMessage, 5);
  if (!ticketDocs || ticketDocs.length === 0) return null;

  const examples = ticketDocs
    .map((doc, idx) => `Example ${idx + 1}:\n${sanitizeTicketText(doc.text || '')}`)
    .join('\n\n');

  if (!process.env.OPENAI_API_KEY) return null;

  const model = new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o',
    temperature: 0.3,
    maxTokens: COMPLEX_PATH_MAX_TOKENS,
  });

  const systemPrompt = `You are a Visor.no customer support assistant.

You are given anonymized examples of previous support tickets (customer questions and agent replies).
Use them as guidance for tone, policies, and typical solutions, but ALWAYS answer the CURRENT user directly.

CRITICAL:
- BE BRIEF: 1-3 sentences for simple questions, 3-5 short bullet points for procedural answers. NEVER write essays.
- Do NOT copy any personal data from the examples (names, emails, phone numbers, addresses, order IDs).
- NEVER invent or output real-looking personal data.
- Generalize from the examples and focus on the user's question.
- Match the language of the user's current message (Norwegian vs English).
- Do NOT start with filler like "Selvfølgelig" or "Of course".

If the examples are not sufficient, give a best-effort helpful answer and, if needed, suggest contacting kundeservice@visor.no or phone support.`;

  const response = await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `Here are some historical ticket examples (sanitized):\n\n${examples}\n\nNow answer this new user question briefly, in the same language as the question:\n\n"${userMessage}"`
    ),
  ]);
  return typeof response.content === 'string' ? response.content : String(response.content || '');
}

// ===========================================================================
// FAST PATH
// ===========================================================================
async function processFastPath(message, conversationHistory, onToken, opts = {}) {
  _lastPath = 'fast';

  const docs = await ragRetrieve(message, { category: opts.category, learnedQa: opts.learnedQa });
  const context = docsToContext(docs);

  if (!context || context.trim().length === 0) return null;

  const modelName = pickFastPathModel(docs);
  if (_lastTrace) _lastTrace.modelUsed = modelName;

  const synthesisModel = new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName,
    temperature: 0.2,
    maxTokens: FAST_PATH_MAX_TOKENS,
    streaming: true,
  });

  const recentHistory = (conversationHistory || []).slice(-4).flatMap((turn) => {
    if (turn.role === 'user') return [new HumanMessage(turn.content)];
    if (turn.role === 'assistant') return [new AIMessage(turn.content)];
    return [];
  });

  const messages = [
    new SystemMessage(getSystemPrompt({ category: opts.category })),
    ...recentHistory,
    new HumanMessage(
      `${message}\n\n[Knowledge base context — answer using only this; do not invent details. Keep your answer SHORT — 1-3 sentences for facts, up to 5 bullet points for steps.]\n\n${context}`
    ),
  ];

  let fullText = '';
  const stream = await synthesisModel.stream(messages);
  for await (const chunk of stream) {
    const token = typeof chunk.content === 'string'
      ? chunk.content
      : (chunk.content?.[0]?.text || '');
    if (token) {
      fullText += token;
      try { onToken(token); } catch (cbErr) {
        console.error('[Stream] onToken error:', cbErr.message);
      }
    }
  }

  return fullText;
}

// ===========================================================================
// COMPLEX PATH
// ===========================================================================
async function processComplexPath(message, conversationHistory, onToken, opts = {}) {
  _lastPath = 'complex';

  const systemPrompt = getSystemPrompt({ category: opts.category });

 // Drop 4 final (hybrid): the orchestrator passed the single learned_qa hit down
  // via opts.learnedQa. The complex path is tool-driven (no unified ranked list),
  // so we blend by injecting it as a SCORE-AWARE candidate the model weighs
  // against its tool results — not as the only source.
  let effectiveSystemPrompt = systemPrompt;
  if (opts.learnedQa && opts.learnedQa.answer) {
    const rel = (opts.learnedQa.score || 0).toFixed(2);
    effectiveSystemPrompt =
      systemPrompt +
      '\n\n=== PREVIOUSLY VALIDATED ANSWER (relevance ' + rel + ') ===\n' +
      'A human admin approved the following answer for a SIMILAR past question. ' +
      'Weigh it alongside your search_* tool results: if it fits this question, prefer it; ' +
      'if your tools surface a clearly better-matching or more current answer, use that instead. ' +
      'Do not treat it as the only source.\n\n' +
      opts.learnedQa.answer;
  }

  const toolDefinitions = getToolDefinitions();

  // One model handles both tool-call decisions AND the final answer (previously
  // a cheaper gpt-4o-mini "router" decided tools, then a separate gpt-4o
  // "synthesis" call re-generated the answer from scratch afterwards — an
  // entire extra round-trip resending the full system prompt + tool results,
  // whose only purpose was upgrading write quality). Using gpt-4o throughout
  // means whichever round comes back with no more tool calls already has a
  // gpt-4o-quality answer ready to use directly — no extra call needed.
  // Tradeoff: tool-decision rounds now cost gpt-4o pricing instead of
  // gpt-4o-mini pricing, and the final answer is chunked/fake-streamed (see
  // fakeStreamText below) rather than truly streamed token-by-token, since
  // it's no longer generated via a dedicated .stream() call.
  const agentModel = new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o',
    temperature: 0.3,
    maxTokens: COMPLEX_PATH_MAX_TOKENS,
  }).bindTools(toolDefinitions);

  if (_lastTrace) _lastTrace.modelUsed = 'gpt-4o';

  const historyMessages = (conversationHistory || []).flatMap((turn) => {
    if (turn.role === 'user') return [new HumanMessage(turn.content)];
    if (turn.role === 'assistant') return [new AIMessage(turn.content)];
    return [];
  });

  const messages = [
    new SystemMessage(effectiveSystemPrompt),
    ...historyMessages,
    new HumanMessage(message),
  ];

  let response = await agentModel.invoke(messages);

  function extractToolCalls(r) {
    if (r.tool_calls && Array.isArray(r.tool_calls)) return r.tool_calls;
    if (r.toolCalls && Array.isArray(r.toolCalls)) return r.toolCalls;
    if (r.additional_kwargs?.tool_calls && Array.isArray(r.additional_kwargs.tool_calls)) {
      return r.additional_kwargs.tool_calls;
    }
    return [];
  }

  let toolCalls = extractToolCalls(response);

  // A single LLM turn can request multiple independent tool calls (e.g. the
  // system prompt explicitly asks for search_faq + search_products together
  // for ordering/measuring questions) — run them concurrently instead of
  // one-at-a-time so the turn only pays for the slowest call, not the sum.
  async function executeToolCall(toolCall) {
    let functionName, functionArgs, toolCallId;

    if (toolCall.name && toolCall.args) {
      functionName = toolCall.name;
      functionArgs = toolCall.args;
    } else if (toolCall.function) {
      functionName = toolCall.function.name;
      functionArgs = toolCall.function.arguments || '{}';
    } else if (toolCall.name) {
      functionName = toolCall.name;
      functionArgs = toolCall.arguments || '{}';
    } else {
      return null;
    }
    toolCallId = toolCall.id || toolCall.tool_call_id;

    // Track tool calls for telemetry
    if (_lastTrace && functionName) {
      _lastTrace.toolCalls.push(functionName);
    }

    let args = {};
    try {
      args = typeof functionArgs === 'string'
        ? JSON.parse(functionArgs || '{}')
        : (functionArgs || {});
    } catch (_) {
      args = {};
    }

    let result = '';
    try {
      switch (functionName) {
          case 'search_faq': {
          result = await runTypedSearch(args.query, 'visor_faqs', message, {
           messageId: opts.assistantMessageId,
           conversationId: opts.dbConversationId,
         });
         break;
       }
          case 'search_products': {
           result = await runTypedSearch(args.query, 'visor_products', message, {
           messageId: opts.assistantMessageId,
           conversationId: opts.dbConversationId,
         });
         break;
       }
       
          
     case 'search_tickets': {
       // Helper to write retrieval telemetry — fire-and-forget.
       const writeTicketTelemetry = (topDoc, count, floor, passed, sourceName) => {
         if (!opts.assistantMessageId || !opts.dbConversationId) return;
         setImmediate(() => {
           retrievalsRepo.insert({
             messageId: opts.assistantMessageId,
             conversationId: opts.dbConversationId,
             source: sourceName || 'visor_tickets',
             queryText: args.query,
             topMatchId: topDoc?.chunkId || null,
             topMatchScore: topDoc?.score || null,
             topMatchText: topDoc?.text || null,
             resultCount: count,
             floor,
             passedFloor: passed,
           }).catch((e) => console.warn('[retrievals] insert failed:', e?.message));
         });
       };

       // Drop 4-light: block ticket synthesis on sensitive policy topics.
       if (isSensitivePolicyQuery(message)) {
         console.log('[search:visor_tickets] SENSITIVE_TOPIC_BLOCKED — refusing ticket synthesis for policy question');
         writeTicketTelemetry(null, 0, null, false, 'visor_tickets');
         result =
           'NO_KNOWLEDGE_BASE_DATA: Ticket history is not authoritative for ' +
           'policy questions (payments, returns, warranty, privacy). Refer the ' +
           'customer to kundeservice@visor.no, or use search_faq results only.';
         break;
       }

       const rawDocs = await searchTickets(args.query, 10);
       if (!rawDocs || rawDocs.length === 0) {
         writeTicketTelemetry(null, 0, null, false, 'visor_tickets');
         result = 'NO_KNOWLEDGE_BASE_DATA: No matching tickets found.';
         break;
       }
       const reranked = reRankByKeywordOverlap(rawDocs, args.query);
       const bestScore = reranked[0]?.score || 0;
       const ticketSource = reranked[0]?.source || 'visor_tickets';
       const floor = CONFIDENCE_FLOORS[ticketSource] ?? 0.55;
       if (bestScore < floor) {
         console.log(`[search:${ticketSource}] LOW_CONFIDENCE best=${bestScore.toFixed(3)} floor=${floor.toFixed(2)}`);
         writeTicketTelemetry(reranked[0], reranked.length, floor, false, ticketSource);
         result = 'NO_KNOWLEDGE_BASE_DATA: No tickets matched confidently.';
       } else {
         writeTicketTelemetry(reranked[0], reranked.length, floor, true, ticketSource);
         if (_lastTrace) {
           _lastTrace.docs.push(...reranked.slice(0, 10).map((d, i) => ({
             chunk_id: d.chunkId || null,
             source: d.source || ticketSource,
             score: d.score || null,
             text: d.text || '',
             rank: i + 1,
           })));
         }
         result = reranked.slice(0, 10)
           .map((d, idx) => `[Context ${idx + 1} from ${d.source}]: ${d.text}`)
           .join('\n\n');
       }
       break;
     }
          case 'get_order_details': {
            const r = await getOrderDetailsTool(args);
            result = JSON.stringify(r);
            break;
          }
          case 'get_order_status': {
            const r = await getOrderStatusTool(args);
            result = JSON.stringify(r);
            break;
          }
        default:
          result = `Unknown tool: ${functionName}`;
      }
    } catch (err) {
      result = `Error: ${err.message}`;
    }

    return {
      tool_call_id: toolCallId,
      role: 'tool',
      name: functionName,
      content: result,
    };
  }

  while (toolCalls && toolCalls.length > 0) {
    const toolResults = (await Promise.all(toolCalls.map(executeToolCall))).filter(Boolean);

    messages.push(response);
    messages.push(...toolResults);
    response = await agentModel.invoke(messages);
    toolCalls = extractToolCalls(response);
  }

  // No more tool calls — this response IS the final answer (already gpt-4o
  // quality, since agentModel is used throughout). Fake-stream it in small
  // chunks via the same onToken callback real streaming uses, so the customer
  // still sees it appear progressively instead of all at once.
  const fullText = typeof response.content === 'string'
    ? response.content
    : (response.content?.[0]?.text || '');

  await fakeStreamText(fullText, onToken);

  return fullText;
}

/**
 * Chunk a complete string into small pieces delivered via onToken with a
 * short delay between them, so a non-streamed answer still appears to type
 * out progressively — matching the cadence real token streaming would give.
 * Mirrors utils/orderResponseFormatter.js's streamTextAsTokens, but drives
 * the generic onToken callback instead of writing SSE frames directly (this
 * call site doesn't have access to the raw response object).
 */
async function fakeStreamText(text, onToken, { delayMs = 20, chunkSize = 3 } = {}) {
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    try { onToken(chunk); } catch (cbErr) {
      console.error('[Stream] onToken error:', cbErr.message);
    }
    if (delayMs > 0 && i + chunkSize < text.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ===========================================================================
// PUBLIC ENTRY POINT
// ===========================================================================
async function processVisorMessageStream(message, conversationHistory = [], onToken = () => {}, opts = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set in environment variables');
  }

  resetTrace();
  const classification = classifyQuery(message, conversationHistory);

  if (classification === 'order') {
    _lastPath = 'order';
    return processComplexPath(message, conversationHistory, onToken, opts);
  }

 // Drop 2/3 learned_qa: one lookup per non-order turn. A high-confidence hit
  // short-circuits to a direct fast answer (no LLM loop); a mid-confidence hit
  // is passed down for the complex path to inject as authoritative context.
  const SHORTCIRCUIT = parseFloat(process.env.RAG_SHORTCIRCUIT_LEARNED || '0.95');
  let routeOpts = opts;
  try {
    const lq = await runLearnedQaSearch(message, {
      messageId: opts.assistantMessageId,
      conversationId: opts.dbConversationId,
    });
    if (lq && lq.passed) {
      if (lq.score >= SHORTCIRCUIT && !lq.isStale) {
        _lastPath = 'learned_qa';
        console.log(`[learned_qa] SHORT-CIRCUIT best=${lq.score.toFixed(3)} >= ${SHORTCIRCUIT.toFixed(2)}`);
        try { onToken(lq.answer); } catch (cbErr) {
          console.error('[Stream] onToken error:', cbErr.message);
        }
        return lq.answer;
      }
      if (lq.score >= SHORTCIRCUIT && lq.isStale) {
        console.log(`[learned_qa] SHORT-CIRCUIT candidate but STALE (>${LEARNED_QA_STALE_DAYS}d) — routing through LLM as a candidate instead`);
      }
      routeOpts = { ...opts, learnedQa: { score: lq.score, answer: lq.answer } };
    }
  } catch (e) {
    console.warn('[learned_qa] lookup skipped:', e?.message);
  }

  if (classification === 'fast_path') {
    try {
      const answer = await processFastPath(message, conversationHistory, onToken, routeOpts);
      if (answer !== null) return answer;
      console.log('[Stream] fast_path empty, falling back to complex');
    } catch (err) {
      console.error('[Stream] fast_path error, falling back:', err.message);
    }
  }

  return processComplexPath(message, conversationHistory, onToken, routeOpts);
}

module.exports = {
  processVisorMessageStream,
  getLastExecutionPath,
  getLastRetrievalTrace,
};
