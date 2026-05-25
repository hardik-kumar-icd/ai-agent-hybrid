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
const { searchSimilar } = require('../utils/embeddingService');
const { searchTickets } = require('../utils/ticketSearch');
const { classifyQuery } = require('../utils/queryClassifier');
const { getCachedEmbedding } = require('../utils/embeddingCache');
const getOrderDetailsTool = require('../tools/getOrderDetailsTool');
const getOrderStatusTool = require('../tools/getOrderStatusTool');

const {
  hasSubstantiveKbContext,
  isSensitivePolicyQuery,
  sanitizeUnsupportedPaymentPolicy,
  reRankByKeywordOverlap,
  sanitizeTicketText,
  getSystemPrompt,
  getToolDefinitions,
} = require('./visorAgentShared');

const FAST_PATH_MAX_TOKENS = 250;
const COMPLEX_PATH_MAX_TOKENS = 500;

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
  const hasProduct = docs.some((d) => {
    const src = (d.source || '').toLowerCase();
    const txt = (d.text || '').toLowerCase();
    if (src.includes('product')) return true;
    if (/\b(price|pris|sku|max.?(width|bredde)|systemb)/i.test(txt)) return true;
    return false;
  });
  if (hasProduct) return 'gpt-4o';
  return 'gpt-4o-mini';
}

async function ragRetrieve(query) {
  const topK = 10;
  // Snapshot the embedding cache state BEFORE the search so we can detect a hit
  const cacheHitBefore = getCachedEmbedding(query) !== null;
  let docs = await searchSimilar(query, topK + 4);
  docs = reRankByKeywordOverlap(docs, query);
  docs = docs.slice(0, topK);

  // Record into trace
  if (_lastTrace) {
    _lastTrace.searchQuery = query;
    _lastTrace.cacheHit = cacheHitBefore;
    _lastTrace.docs = docs.map((d, idx) => ({
      chunk_id: d.chunkId || d.chunk_id || null,
      source: d.source || null,
      score: d.score || null,
      text: d.text || '',
      rank: idx + 1,
    }));
  }

  return docs;
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

If the examples are not sufficient, give a best-effort helpful answer and, if needed, suggest contacting kundeservice@test.visor.no or phone support.`;

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
async function processFastPath(message, conversationHistory, onToken) {
  _lastPath = 'fast';

  const docs = await ragRetrieve(message);
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
    new SystemMessage(getSystemPrompt()),
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

  return sanitizeUnsupportedPaymentPolicy(fullText, message);
}

// ===========================================================================
// COMPLEX PATH
// ===========================================================================
async function processComplexPath(message, conversationHistory, onToken) {
  _lastPath = 'complex';

  const systemPrompt = getSystemPrompt();
  const toolDefinitions = getToolDefinitions();

  const routerModel = new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini',
    temperature: 0.2,
  }).bindTools(toolDefinitions);

  const historyMessages = (conversationHistory || []).flatMap((turn) => {
    if (turn.role === 'user') return [new HumanMessage(turn.content)];
    if (turn.role === 'assistant') return [new AIMessage(turn.content)];
    return [];
  });

  const messages = [
    new SystemMessage(systemPrompt),
    ...historyMessages,
    new HumanMessage(message),
  ];

  let response = await routerModel.invoke(messages);

  function extractToolCalls(r) {
    if (r.tool_calls && Array.isArray(r.tool_calls)) return r.tool_calls;
    if (r.toolCalls && Array.isArray(r.toolCalls)) return r.toolCalls;
    if (r.additional_kwargs?.tool_calls && Array.isArray(r.additional_kwargs.tool_calls)) {
      return r.additional_kwargs.tool_calls;
    }
    return [];
  }

  let toolCalls = extractToolCalls(response);

  while (toolCalls && toolCalls.length > 0) {
    const toolResults = [];

    for (const toolCall of toolCalls) {
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
        continue;
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
          case 'rag_search': {
            const ragResult = await ragToolFast(args);
            const kbHasSubstantive = hasSubstantiveKbContext(ragResult);
            const sensitive = isSensitivePolicyQuery(message);

            if (!kbHasSubstantive && !sensitive) {
              const ticketAnswer = await answerFromTicketsFast(message);
              result = ticketAnswer
                ? `[Ticket-based answer]\n${ticketAnswer}`
                : ragResult;
            } else {
              result = ragResult;
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

      toolResults.push({
        tool_call_id: toolCallId,
        role: 'tool',
        name: functionName,
        content: result,
      });
    }

    messages.push(response);
    messages.push(...toolResults);
    response = await routerModel.invoke(messages);
    toolCalls = extractToolCalls(response);
  }

  const synthesisModel = new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o',
    temperature: 0.3,
    maxTokens: COMPLEX_PATH_MAX_TOKENS,
    streaming: true,
  });

  if (_lastTrace) _lastTrace.modelUsed = 'gpt-4o';

  const finalMessages = messages.slice();
  finalMessages.push(new HumanMessage(
    'Write the final answer NOW. Be BRIEF: for comparisons use 2-3 short bullet points per item (1 line each). For simple facts use 1-2 sentences. Never exceed ~350 words. Use tool results above. Same language as the user\'s last message. Do not write introductions or closing paragraphs.'
  ));

  let fullText = '';
  const stream = await synthesisModel.stream(finalMessages);

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

  return sanitizeUnsupportedPaymentPolicy(fullText, message);
}

// ===========================================================================
// PUBLIC ENTRY POINT
// ===========================================================================
async function processVisorMessageStream(message, conversationHistory = [], onToken = () => {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set in environment variables');
  }

  resetTrace();
  const classification = classifyQuery(message, conversationHistory);

  if (classification === 'order') {
    _lastPath = 'order';
    return processComplexPath(message, conversationHistory, onToken);
  }

  if (classification === 'fast_path') {
    try {
      const answer = await processFastPath(message, conversationHistory, onToken);
      if (answer !== null) return answer;
      console.log('[Stream] fast_path empty, falling back to complex');
    } catch (err) {
      console.error('[Stream] fast_path error, falling back:', err.message);
    }
  }

  return processComplexPath(message, conversationHistory, onToken);
}

module.exports = {
  processVisorMessageStream,
  getLastExecutionPath,
  getLastRetrievalTrace,
};
