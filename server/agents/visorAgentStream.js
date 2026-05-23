/**
 * Streaming variant of the Visor agent.
 *
 * Same tool-calling loop as processVisorMessage(), but the FINAL answer is
 * streamed token-by-token via an onToken(text) callback so the route can push
 * each chunk to the client via Server-Sent Events.
 *
 * Latency wins implemented here:
 *  1. Tool-decision step uses gpt-4o-mini (cheaper + faster) — it just decides
 *     which tool to call.
 *  2. Final synthesis step uses gpt-4o (quality) but streams, so user sees
 *     first token within ~500ms instead of waiting for the whole answer.
 *  3. Query expansion is dropped (saves an extra LLM round-trip per RAG call).
 *  4. RAG over-fetch fixed in embeddingService.js (separate file).
 *
 * This file is purely additive — the original processVisorMessage() in
 * visorAgent.js is untouched and remains the non-streaming fallback.
 */

const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, AIMessage, SystemMessage, ToolMessage } = require('@langchain/core/messages');
const { searchSimilar } = require('../utils/embeddingService');
const { searchTickets } = require('../utils/ticketSearch');
const getOrderDetailsTool = require('../tools/getOrderDetailsTool');
const getOrderStatusTool = require('../tools/getOrderStatusTool');

// Reuse helpers from the existing agent so behaviour stays identical.
// (These are exported in the patch we add to visorAgent.js — see PR.)
const {
  hasSubstantiveKbContext,
  isSensitivePolicyQuery,
  sanitizeUnsupportedPaymentPolicy,
  reRankByKeywordOverlap,
  sanitizeTicketText,
  ticketMatchesQuery,
  getSystemPrompt,
  getToolDefinitions,
} = require('./visorAgentShared');

/**
 * RAG tool — same logic as the original, but without the expandQueryForSearch()
 * call that added ~500ms per search for marginal gain.
 */
async function ragToolFast({ query }) {
  try {
    const topK = 10;
    let docs = await searchSimilar(query, topK + 4); // small over-fetch for re-rank
    docs = reRankByKeywordOverlap(docs, query);
    docs = docs.slice(0, topK);

    const context = docs
      .map((doc, idx) => `[Context ${idx + 1} from ${doc.source}]: ${doc.text}`)
      .join('\n\n');

    if (!context || context.trim().length === 0) {
      return 'NO_KNOWLEDGE_BASE_DATA: The knowledge base is empty or contains no relevant information. Do NOT make up products or use training data.';
    }
    return context;
  } catch (error) {
    console.error('[RAG Tool Stream] Error:', error);
    return `Error searching knowledge base: ${error.message}`;
  }
}

/**
 * Ticket fallback — same as original (only triggered if KB has no substantive data).
 * Not streamed because it's a fallback path used in <10% of queries.
 */
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

/**
 * Process a Visor message with streaming.
 *
 * @param {string} message - Current user message
 * @param {Array<{role: 'user'|'assistant', content: string}>} conversationHistory
 * @param {(token: string) => void} onToken - Called for each chunk of the final answer
 * @returns {Promise<string>} - Full final answer (also accumulated from streamed tokens)
 */
async function processVisorMessageStream(message, conversationHistory = [], onToken = () => {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set in environment variables');
  }

  const systemPrompt = getSystemPrompt();
  const toolDefinitions = getToolDefinitions();

  // ---------------------------------------------------------------------
  // Step 1: tool-decision pass with gpt-4o-mini (fast, cheap, accurate enough
  // to pick the right tool). Not streamed because we need the tool calls
  // before we can do anything useful.
  // ---------------------------------------------------------------------
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

  // Normalize tool_calls across LangChain response variants
  function extractToolCalls(r) {
    if (r.tool_calls && Array.isArray(r.tool_calls)) return r.tool_calls;
    if (r.toolCalls && Array.isArray(r.toolCalls)) return r.toolCalls;
    if (r.additional_kwargs?.tool_calls && Array.isArray(r.additional_kwargs.tool_calls)) {
      return r.additional_kwargs.tool_calls;
    }
    return [];
  }

  let toolCalls = extractToolCalls(response);

  // ---------------------------------------------------------------------
  // Step 2: run tool-calling loop. Each iteration may bring more tool calls.
  // We keep the router (mini) for follow-up tool decisions and only switch
  // to the synthesis model when we have a final answer to stream.
  // ---------------------------------------------------------------------
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

  // ---------------------------------------------------------------------
  // Step 3: We now have tool results + the router's final message.
  // Re-generate the final answer with gpt-4o STREAMING. This is where the
  // user perceives the latency improvement.
  //
  // Why re-generate instead of using the router's final text? Two reasons:
  //  - The router was gpt-4o-mini, which can be terser than we want.
  //  - We get streaming "for free" by switching to model.stream() here.
  // ---------------------------------------------------------------------
  const synthesisModel = new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o',
    temperature: 0.4,
    streaming: true,
  });

  // Build a final-answer message list:
  // system + history + user + tool messages + a synthesis nudge
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
      try {
        onToken(token);
      } catch (cbErr) {
        // Don't let a callback error kill the stream
        console.error('[Stream] onToken callback error:', cbErr.message);
      }
    }
  }

  const sanitized = sanitizeUnsupportedPaymentPolicy(fullText, message);
  return sanitized;
}

module.exports = {
  processVisorMessageStream,
};
