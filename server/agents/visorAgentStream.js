/**
 * Streaming variant of the Visor agent — with FAQ FAST PATH.
 *
 * Two execution paths:
 *
 *   FAST PATH (FAQ-style queries, classified by queryClassifier.js):
 *     - Skip the LLM router (saves ~800ms)
 *     - Direct rag_search call (with embedding cache)
 *     - Stream the answer with gpt-4o-mini if context is simple (1-2 chunks,
 *       no products), gpt-4o if it's product-rich
 *     - Total: ~2.2s typical, ~1.5-1.8s on cache hit
 *
 *   COMPLEX PATH (default — multi-part, ambiguous, comparison, follow-up):
 *     - Full tool-routing loop with gpt-4o-mini for routing decisions
 *     - Synthesis with gpt-4o (streaming)
 *     - Total: ~3-4s
 *
 * Both paths stream tokens via the same onToken(text) callback.
 * Both paths emit the same return value so the route layer doesn't care
 * which one ran (the route only needs the optional `path` debug header,
 * which we expose via getLastExecutionPath()).
 */

const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
const { searchSimilar } = require('../utils/embeddingService');
const { searchTickets } = require('../utils/ticketSearch');
const { classifyQuery } = require('../utils/queryClassifier');
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

// ---------------------------------------------------------------------------
// Last execution path — exposed for the route layer's debug meta event.
// Stored as a closure variable so we can tell the caller which path ran
// without changing the function signature.
// ---------------------------------------------------------------------------
let _lastPath = 'complex';
function getLastExecutionPath() {
  return _lastPath;
}

// ---------------------------------------------------------------------------
// Conservative model picker — used by the FAST PATH only.
// Decides which model synthesizes the answer based on retrieval results.
//
//   gpt-4o-mini:   short FAQ-style answers (≤2 KB chunks, no products)
//   gpt-4o:        anything with ≥3 chunks OR product content
//
// The complex path always uses gpt-4o for synthesis (existing behaviour).
// ---------------------------------------------------------------------------
function pickFastPathModel(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return 'gpt-4o-mini';

  // 3+ KB chunks → use 4o (we're synthesizing across multiple sources)
  if (docs.length >= 3) return 'gpt-4o';

  // Any chunk from a product source → use 4o (richer formatting needed)
  const hasProduct = docs.some((d) => {
    const src = (d.source || '').toLowerCase();
    const txt = (d.text || '').toLowerCase();
    // Heuristic: source names like 'products', 'visor_products', or text containing
    // product-specific markers (price, sku, max_width, attributes)
    if (src.includes('product')) return true;
    if (/\b(price|pris|sku|max.?(width|bredde)|systemb)/i.test(txt)) return true;
    return false;
  });
  if (hasProduct) return 'gpt-4o';

  // Default: short FAQ answer → mini is plenty
  return 'gpt-4o-mini';
}

// ---------------------------------------------------------------------------
// RAG retrieval — same as complex path, just exposed so fast path can call
// it without going through the LLM tool loop.
// ---------------------------------------------------------------------------
async function ragRetrieve(query) {
  const topK = 10;
  let docs = await searchSimilar(query, topK + 4);
  docs = reRankByKeywordOverlap(docs, query);
  docs = docs.slice(0, topK);
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

// ---------------------------------------------------------------------------
// Ticket fallback (rarely used, kept identical to complex path).
// ---------------------------------------------------------------------------
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
    temperature: 0.5,
  });

  const systemPrompt = `You are a Visor.no customer support assistant.

You are given anonymized examples of previous support tickets (customer questions and agent replies).
Use them as guidance for tone, policies, and typical solutions, but ALWAYS answer the CURRENT user directly.

CRITICAL:
- Do NOT copy any personal data from the examples (names, emails, phone numbers, addresses, order IDs).
- NEVER invent or output real-looking personal data.
- Generalize from the examples and focus on the user's question.
- Match the language of the user's current message (Norwegian vs English).

If the examples are not sufficient, give a best-effort helpful answer and, if needed, suggest contacting kundeservice@test.visor.no or phone support.`;

  const response = await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `Here are some historical ticket examples (sanitized):\n\n${examples}\n\nNow answer this new user question, in the same language as the question:\n\n"${userMessage}"`
    ),
  ]);
  return typeof response.content === 'string' ? response.content : String(response.content || '');
}

// ===========================================================================
// FAST PATH
// ===========================================================================
async function processFastPath(message, conversationHistory, onToken) {
  _lastPath = 'fast';

  // 1. Direct retrieval (no LLM router call)
  const docs = await ragRetrieve(message);
  const context = docsToContext(docs);

  // No KB hits at all → fall through to complex path (which can try tickets)
  if (!context || context.trim().length === 0) {
    return null;  // sentinel: caller should retry on complex path
  }

  // Pick model based on context shape (conservative)
  const modelName = pickFastPathModel(docs);

  const synthesisModel = new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName,
    temperature: 0.3,
    streaming: true,
  });

  // Build minimal message list — system prompt + last 2 turns + current question + context
  const recentHistory = (conversationHistory || []).slice(-4).flatMap((turn) => {
    if (turn.role === 'user') return [new HumanMessage(turn.content)];
    if (turn.role === 'assistant') return [new AIMessage(turn.content)];
    return [];
  });

  const messages = [
    new SystemMessage(getSystemPrompt()),
    ...recentHistory,
    new HumanMessage(
      `${message}\n\n[Knowledge base context — answer using only this; do not invent details]\n\n${context}`
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
// COMPLEX PATH (existing tool-routing loop with streaming synthesis)
// ===========================================================================
async function processComplexPath(message, conversationHistory, onToken) {
  _lastPath = 'complex';

  const systemPrompt = getSystemPrompt();
  const toolDefinitions = getToolDefinitions();

  // Tool-decision pass — gpt-4o-mini is fast + accurate enough for routing
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

  // Final synthesis with gpt-4o streaming
  const synthesisModel = new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o',
    temperature: 0.4,
    streaming: true,
  });

  const finalMessages = messages.slice();
  finalMessages.push(new HumanMessage(
    'Now write the final answer to the user. Use the tool results above. Same language as the user\'s last message.'
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

  const classification = classifyQuery(message, conversationHistory);

  // Order intent — always use complex path (it has the order tools)
  if (classification === 'order') {
    _lastPath = 'order';  // distinguished from 'complex' for telemetry
    return processComplexPath(message, conversationHistory, onToken);
  }

  // FAST PATH — try first, fall back to complex if no KB hit
  if (classification === 'fast_path') {
    try {
      const answer = await processFastPath(message, conversationHistory, onToken);
      if (answer !== null) return answer;
      // Fall through if fast path returned null (no KB hits)
      console.log('[Stream] fast_path empty, falling back to complex');
    } catch (err) {
      console.error('[Stream] fast_path error, falling back:', err.message);
    }
  }

  // COMPLEX PATH (default + fallback)
  return processComplexPath(message, conversationHistory, onToken);
}

module.exports = {
  processVisorMessageStream,
  getLastExecutionPath,
};
