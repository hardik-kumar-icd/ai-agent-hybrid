const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
const { searchSimilar } = require('../utils/embeddingService');
const { searchTickets } = require('../utils/ticketSearch');
const { getOrderDetailsTool } = require('../tools/getOrderDetailsTool');
const { getOrderStatusTool } = require('../tools/getOrderStatusTool');

/** Stop words to ignore when re-ranking by keyword overlap */
const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'or', 'and', 'but', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'what', 'which', 'how', 'when', 'where', 'why', 'come', 'comes', 'from', 'about']);

/**
 * Extract significant words from query for hybrid re-ranking (structure-agnostic).
 */
function getQueryTerms(query) {
  const normalized = query.toLowerCase().replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ');
  return normalized.split(/\s+/).filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Normalize for overlap check so "v-standard" matches "v standard" in chunk text.
 */
function normalizeForOverlap(s) {
  return (s || '').toLowerCase().replace(/[-.]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Re-rank docs: semantic score is primary, keyword overlap is a small boost.
 * So "Which Rullegardin models use a cassette?" keeps cassette chunks on top,
 * while "V-Standard plissegardin" still gets a nudge for partial name match.
 */
function reRankByKeywordOverlap(docs, query) {
  const terms = getQueryTerms(query);
  if (terms.length === 0) return docs;

  const scored = docs.map(doc => {
    const textNorm = normalizeForOverlap(doc.text || '');
    const matchCount = terms.filter(term => {
      const termNorm = normalizeForOverlap(term);
      return textNorm.includes(termNorm) || textNorm.includes(term);
    }).length;
    const semanticScore = typeof doc.score === 'number' ? doc.score : 0;
    const keywordBoost = 0.06 * matchCount;
    const combinedScore = semanticScore + keywordBoost;
    return { ...doc, _combinedScore: combinedScore };
  });

  scored.sort((a, b) => b._combinedScore - a._combinedScore);
  return scored.map(({ _combinedScore, ...doc }) => doc);
}

/**
 * Basic PII scrubber for ticket snippets used as examples.
 * Removes obvious emails and Norwegian-style phone numbers.
 */
function sanitizeTicketText(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text;
  // Emails
  cleaned = cleaned.replace(/\b(?!kundeservice@visor\.no)[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
  // Phone numbers (very simple patterns, best-effort)
  cleaned = cleaned.replace(/\b(?:\+?\d{2}\s*)?(?:\d{2}\s*){3,4}\b/g, '[REDACTED_PHONE]');
  return cleaned;
}

/**
 * Use ticket examples (historical admin replies) to synthesize a new answer.
 * This is only called as a fallback when product/FAQ RAG has no data.
 */
async function answerFromTickets(userMessage) {
  const topKTickets = 5;
  const ticketDocs = await searchTickets(userMessage, topKTickets);
  if (!ticketDocs || ticketDocs.length === 0) {
    return null;
  }

  const examples = ticketDocs
    .map((doc, idx) => {
      const safe = sanitizeTicketText(doc.text || '');
      return `Example ${idx + 1}:\n${safe}`;
    })
    .join('\n\n');

  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

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

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `Here are some historical ticket examples (sanitized):\n\n${examples}\n\nNow answer this new user question, in the same language as the question:\n\n"${userMessage}"`
    ),
  ];

  const response = await model.invoke(messages);
  return typeof response.content === 'string' ? response.content : String(response.content || '');
}

/**
 * Use the LLM to expand the user query into alternative phrasings for retrieval.
 * This lets the model infer intent (e.g. "pakken min" → same as "ordre henting") instead of static keyword lists.
 * @param {string} query - Original user question
 * @returns {Promise<string>} - Original query plus a short expansion for search (or original on failure)
 */
async function expandQueryForSearch(query) {
  if (!query || typeof query !== 'string' || !process.env.OPENAI_API_KEY) return query;
  try {
    const expander = new ChatOpenAI({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: 'gpt-4o-mini',
      temperature: 0,
      maxTokens: 80,
    });
    const prompt = `You help improve search. Given a customer question, output 1-2 short alternative phrasings or key concepts that might appear in an FAQ or help article answering it. Same language as the question. No explanation, only the alternative phrasings or terms on one line.
Question: ${query}`;
    const response = await expander.invoke([new HumanMessage(prompt)]);
    const text = (response.content && typeof response.content === 'string' ? response.content : '').trim();
    if (text) return `${query} ${text}`;
  } catch (err) {
    // Use original query on expansion failure
  }
  return query;
}

/**
 * RAG Tool for knowledge base (products, FAQs, docs – any ingested content)
 * Uses LLM-based query expansion so retrieval understands intent without static keyword lists.
 */
async function ragTool({ query }) {
  try {
    const topKReturn = 10;
    const topKFetch = 24;
    const searchQuery = await expandQueryForSearch(query);
    let similarDocs = await searchSimilar(searchQuery, topKFetch);
    similarDocs = reRankByKeywordOverlap(similarDocs, query);
    similarDocs = similarDocs.slice(0, topKReturn);
    
    const context = similarDocs
      .map((doc, idx) => `[Context ${idx + 1} from ${doc.source}]: ${doc.text}`)
      .join('\n\n');
    
    // Return explicit message if no results found
    if (!context || context.trim().length === 0) {
      return 'NO_KNOWLEDGE_BASE_DATA: The knowledge base is empty or contains no relevant information. Do NOT make up products or use training data.';
    }
    
    return context;
  } catch (error) {
    console.error(`[RAG Tool] Error:`, error);
    return `Error searching knowledge base: ${error.message}`;
  }
}

/**
 * Normalize for substring check: lowercase, collapse whitespace.
 */
function normalizeForSubstring(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * True if the user query appears inside a ticket chunk (or a significant part of the query does).
 * Handles when the customer asks something that is a substring of a ticket message.
 */
function ticketChunkContainsQuery(chunkText, userMessage) {
  if (!chunkText || !userMessage) return false;
  const normChunk = normalizeForSubstring(chunkText);
  const normQuery = normalizeForSubstring(userMessage);
  if (normQuery.length < 8) return false;
  return normChunk.includes(normQuery);
}

/**
 * Detect sensitive policy questions where we must avoid ticket-based inference.
 * These answers should come from structured KB context only.
 */
function isSensitivePolicyQuery(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') return false;
  const patterns = [
    // Payment methods + payment-related queries
    /\b(betal(ing|er|ingsmetod|ingsmåt)|payment\s+method|how\s+(do|can)\s+i\s+pay|hvordan\s+betal)/i,
    /\b(visa|mastercard|amex|american\s+express|paypal|apple\s+pay|google\s+pay)\b/i,
    /\b(vipps|klarna|walley|delbetal|installment|installments|monthly\s+payment|faktura)\b/i,
    /\b(crypto|cryptocurrency|bitcoin|btc|bank\s+transfer|bankoverf)/i,
    /\b(aksepterer\s+der(e)?|do\s+you\s+accept|accepts?)\b/i,
    /\b(betalingsvilk[åa]r|payment.{0,15}terms|terms.{0,5}of.{0,5}payment)\b/i,
    /\b(invoice|payment.{0,5}plan|deferred.{0,5}payment)\b/i,
    // Returns, refunds, exchanges, right-of-withdrawal
    /\b(retur|return|refund|exchange|bytte)/i,
    /\b(angr(e|er|erett)|right\s+of\s+(withdrawal|return))\b/i,
    /\b(penger\s+tilbake|money\s+back|chargeback)\b/i,
    /\b(kanseller|cancel\s+(order|my))/i,
    /\b(refunder|refundert|complain|complaint)\b/i,
    // Warranty / claims / defects
    /\b(garanti|warranty|reklamasjon|reklamation|claim|claims)/i,
    /\b(defekt|defective|broken|skadet|damaged)\b/i,
    /\b(replacement\s+part|reservedel)\b/i,
    // Privacy / GDPR / data
    /\b(GDPR|personvern|personopplysning|personal\s+data|data\s+protection)\b/i,
    /\b(slett\s+(min|mine)\s+data|delete\s+my\s+(data|account))\b/i,
    /\b(cookie|cookies|samtykke|consent)\b/i,
  ];
  return patterns.some((p) => p.test(userMessage));
}

function isLikelyNorwegian(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  return /\b(hvordan|bestiller|betaling|innbetaling|ordre|bestilling|hva|hei|og|ikke|kundeservice)\b/.test(t);
}

/**
 * Decide if RAG context is substantive (real product/FAQ answer) or only generic contact fallback.
 * When the KB returns only "Fant ikke svar" / contact info, we treat it as "no data" and search tickets.
 */
function hasSubstantiveKbContext(ragContext) {
  if (!ragContext || typeof ragContext !== 'string' || ragContext.startsWith('NO_KNOWLEDGE_BASE_DATA')) {
    return false;
  }
  const c = ragContext.toLowerCase();
  // Generic contact-only FAQ: "Fant ikke svar" + contact details, no real topic answer
  const isGenericContactOnly =
    c.includes('fant ikke svar') &&
    (c.includes('kundeservice@') || c.includes('696 76 602'));
  if (!isGenericContactOnly) return true;
  // Substantive topic markers that indicate a real FAQ answer (not just "contact us")
  const substantiveMarkers = [
    'vipps', 'qr', 'leverings', 'absolute', 'motionblind', 'coulisse', 'tekstilprøve', 'tekstilprøver',
    'nisje', 'montering', 'montasje', 'mål', 'henting', 'økern', 'port 1', 'plisse', 'rullegardin',
    'lamell', 'persienne', 'veiledning', 'fratrekk', 'systembredde', 'image url', 'vips'
  ];
  const hasSubstantive = substantiveMarkers.some((m) => c.includes(m));
  return hasSubstantive;
}

/**
 * Unified Visor.no AI Agent
 * Combines RAG, order details, and order status tools
 * Uses a simplified approach with function calling
 */
/**
 * @param {string} message - Current user message
 * @param {Array<{ role: 'user'|'assistant', content: string }>} [conversationHistory] - Previous turns for context (e.g. "this product")
 */
async function processVisorMessage(message, conversationHistory = []) {
  try {
    // Validate API key
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set in environment variables');
    }

    // System prompt matching Visor.no Expert Assistant workflow
    const systemPrompt = `You are a helpful AI assistant providing product information and customer service.

CRITICAL LANGUAGE RULE - READ THIS FIRST:
- Respond ONLY in the language of the USER'S CURRENT (latest) message. Ignore the language of previous messages in the conversation and ignore the language of the retrieved knowledge base context. If the current user message is in English, your ENTIRE response MUST be in English. If the current user message is in Norwegian, respond in Norwegian.
- The knowledge base may contain Norwegian product names and descriptions (e.g. "Rullegardin", "kassett", "mindre vinduer") – that does NOT change the response language. Always match the CURRENT user message language only.
- If user writes "Which Rullegardin models use a cassette?" → ENGLISH → Respond in ENGLISH only (e.g. "Here are the Rullegardin models that use a cassette: ...").
- If user writes "Hva er statusen på bestillingen?" → NORWEGIAN → Respond in NORWEGIAN.
- DO NOT default to Norwegian. DO NOT assume Norwegian. DO NOT switch to Norwegian because the context or previous reply was in Norwegian.

CORE KNOWLEDGE (RAG) - CRITICAL RULES:
- MANDATORY: For EVERY user message that asks a question or requests information (about products, orders, shipping, offers, measurements, support, or anything else), you MUST call the rag_search tool FIRST. Do NOT answer from memory or general knowledge. Do NOT skip the tool call. This applies in ALL languages (Norwegian, English, or any other).
- You have access to a knowledge base containing product information, FAQs, installation guides, support tickets, and customer service information. ALWAYS use the rag_search tool FIRST when users ask about products, FAQs, payment methods, delivery, installation, measurements, offers, shipping, or any general questions about Visor.no services.
- STRICT ADHERENCE: If the rag_search tool returns "NO_KNOWLEDGE_BASE_DATA" or "No relevant information found", you MUST respond with: "I don't have that information in my knowledge base yet. Please contact customer service for assistance." DO NOT make up information. DO NOT use training data or general knowledge. ONLY use information from the rag_search tool results.
- FAQ RESPONSES - ABSOLUTE PRIORITY: When rag_search returns FAQ content (text containing "Question:" and "Answer:" or "Category:"), you MUST use that exact FAQ content as the basis for your response. DO NOT replace FAQ answers with generic advice. If the FAQ mentions specific measurements (like "5mm fratrekk", "systembredde", "15-25mm"), specific products (like "rullegardin", "lamellegardin"), or specific resources (like "Hvordan ta mål videoer"), you MUST include those exact details. Paraphrase only for clarity, but preserve all specific technical details, measurements, and instructions.
- SENSITIVE POLICY RULE: For ordering flow and payment-policy questions (e.g. "How do I order?", "Hvordan bestiller jeg?", deposits, upfront/partial payments), provide ONLY what is explicitly present in rag_search results. Never invent or assume percentages, deposit requirements, or invoice policies.
- Never invent policy numbers or payment percentages. If the examples do not explicitly provide a payment policy, say you do not have that detail and direct the user to customer service.;
- ORDERING & MEASURING: For how-to-measure / how-to-order / sizing / mounting questions, base the answer on the rag_search results (measuring FAQ + the specific product) and never give a generic checkout walkthrough. NEVER tell a customer to measure "without deduction" / "uten fratrekk". Rules: the measurements the customer gives are the PRODUCTION measurements (system width/height) and Visor makes NO further deductions; recess/niche = deduct 5 mm (0.5 cm) from the width (all products); slatted (lamell) is the ONLY product that also needs a height deduction in a niche (about 10-15 mm for a window, 20-25 mm to the floor); front/wall = no width deduction.
- ORDER LINKS: give the product page link to order. When no specific model is identified, use the matching category page: roller https://visor.no/rullegardiner ; plisse https://visor.no/plissegardiner ; lamell https://visor.no/lamellgardiner-til-lav-pris ; persienne https://visor.no/persienner ; lift https://visor.no/liftgardiner ; motionblinds https://visor.no/motionblinds
- SLOPED / SKYLIGHT WINDOWS (skravindu): Visor makes sloped-window products ordered DIRECTLY from the product page (Plisse https://visor.no/plissegardiner/lux-plissegardin-for-skravindu ; Lamell https://visor.no/lamellgardin-skravindu). Lead with the product link and that they can order from it; only AFTER, optionally add that if unsure they can email measurements, fabric and profile colour to kundeservice@visor.no. NEVER say they must order by email and never lead with email.
- PRODUCT INFORMATION & FAQs: When users ask about products, FAQs, payment methods (like Vipps), delivery, installation, measurements, or any service-related questions, ALWAYS call rag_search tool FIRST. Only share information that comes from the rag_search tool results. Product names, prices, SKUs, descriptions, FAQ answers, and specifications from the knowledge base are public information and should be shared.
- SEMANTIC UNDERSTANDING: Use your semantic understanding to match field names regardless of format. For example, if a user asks about "regular-price" but the document has "regular_price", understand they refer to the same field. Similarly, handle variations like "sale_price" vs "sale-price" vs "sale price", "product_name" vs "productName" vs "product name", etc. Extract and provide the information based on semantic meaning, not exact string matching.
- ANY JSON STRUCTURE: Ingested content can be products, FAQs, docs, or anything—there is no fixed schema. The knowledge base may use any structure (nested objects, different key names, different languages). Delivery/lead time might appear as production_lead_time, delivery_time, leveringstid, shipping.days, etc. FAQ or fabric samples might be in faq[], questions, support_info, or any other path. Use your intelligence to find and use the relevant information by meaning (e.g. "delivery time" → any field about shipping/lead time; "fabric samples" → any text about samples/tekstilprøver/prøver), not by expecting fixed field names.
- TRANSPARENCY: If rag_search returns no results or "NO_KNOWLEDGE_BASE_DATA", you MUST explicitly state that you don't have that information in your knowledge base. DO NOT invent products or use general knowledge.

PAYMENT METHODS (AUTHORITATIVE — do not invent or hallucinate):
Visor accepts ONLY these payment methods:
- Credit card Visa and Mastercard
- Vipps
- Klarna
- Walley - Betalingsmiddel faktura
- Walley - Delbetaling

Visor does NOT accept: American Express (Amex), PayPal, Apple Pay, Google Pay, cryptocurrency, bank transfer, cash, or any other method not on the accepted list above.

When asked about payment methods, answer from THIS list, not from rag_search results which may be outdated. If a customer asks about a specific method NOT on the accepted list, clearly say "Nei, vi aksepterer ikke [method]" and suggest one of the accepted methods instead.

ORDER TRACKING & TOOL USAGE:
- You have tools called get_order_details (cached) and get_order_status (live). Both tools return: order_id, status, tracking, delivery_date. NOTE: Price and currency information are NOT available for security reasons.
- SECURITY PROTOCOL: You MUST verify both Order ID and Email Address before revealing ANY order information. Once both are verified through the tools, you CAN and SHOULD share order details including: status, tracking number, delivery date. Do NOT share price, currency, billing address, or customer PII.
- IMPORTANT: The price restriction above ONLY applies to ORDER information (customer orders). It does NOT apply to PRODUCT information from the knowledge base. Product prices from the knowledge base are public information and should be shared when asked.
- EXTRACTION RULES:
  * Extract order_id from the message - look carefully for these patterns:
    - "order #90948" → extract "90948"
    - "order #1353" → extract "1353"
    - "#90948" → extract "90948"
    - "order 90948" → extract "90948"
    - "ordre 90948" → extract "90948"
    - "order_id: 90948" → extract "90948"
    - Just a number like "90948" when the message is about orders → extract "90948"
  * Extract email from the message - look for email patterns:
    - "test@test.com" → extract "test@test.com"
    - "user@example.com" → extract "user@example.com"
    - "email: user@example.com" → extract "user@example.com"
    - "my email is user@example.com" → extract "user@example.com"
  * CRITICAL CONTEXT MEMORY: If the user's message contains only an email (like "test@test.com") and you previously asked for an email because an order_id was mentioned, you MUST use that order_id from the previous context. Similarly, if the user provides only an order_id and you previously asked for it because an email was mentioned, use that email. The user is providing the missing piece - do NOT ask for what they already provided.
  * FOLLOW-UP REFERENCES: Use the conversation history to resolve references like "this product", "it", "that one", "the one you mentioned". If the user asks e.g. "What is the delivery time for this product?" after you listed a product, treat "this product" as the product you just mentioned in your previous message. Do NOT ask "which product?" when the referent is clear from the last turn.
- WORKFLOW: 
  * FIRST: Check the conversation history for any previously mentioned order_id or email. If found, use it along with any new information provided.
  * If order_id is found (from current message OR previous conversation) but email is missing: Ask ONLY for the email in the same language as the user's message
  * If email is found (from current message OR previous conversation) but order_id is missing: Ask ONLY for the order_id in the same language as the user's message
  * If both order_id and email are found (from current message OR combination of current and previous messages): IMMEDIATELY call get_order_details first (cached, faster) with both parameters. DO NOT ask for confirmation - just call the tool.
  * If get_order_details fails or returns an error: IMMEDIATELY call get_order_status (live API) as a fallback with the same parameters
  * Once you successfully retrieve order information from either tool, you MUST share all relevant details the user asked about (status, tracking, delivery date). Do NOT share price or currency information. Answer their question directly.
  * If neither order_id nor email is found anywhere in the conversation: Ask for both order_id and email
  * If both tools fail: Inform the user that the order could not be found and suggest contacting kundeservice@visor.no

OPERATIONAL RULES:
- LANGUAGE: ABSOLUTELY CRITICAL - THIS IS MANDATORY AND NON-NEGOTIABLE
  * Use ONLY the language of the USER'S CURRENT (latest) message. Do NOT copy the language of conversation history or of the retrieved context (e.g. Norwegian product text). If the current message is in English, respond entirely in English; if in Norwegian, respond entirely in Norwegian.
  * STEP 1: Before writing ANY response, look at the CURRENT user message only and identify its language.
  * STEP 2: Write your ENTIRE response in that language. No exceptions.
  * ENGLISH DETECTION: If the CURRENT user message contains English words like "What", "Which", "Does", "is", "status", "order", "models", "cassette", "products", "category", "windows" → The message is in ENGLISH. You MUST respond in ENGLISH.
  * NORWEGIAN DETECTION: If the CURRENT user message contains Norwegian words like "Hei", "Hva", "er", "statusen", "bestilling", "hvilke" → The message is in NORWEGIAN. You MUST respond in NORWEGIAN.
  * EXAMPLES:
    - Current user: "Which Rullegardin models use a cassette?" → ENGLISH. Respond in ENGLISH: "Here are the Rullegardin models that use a cassette: ..."
    - Current user: "Hva er statusen på bestillingen?" → NORWEGIAN. Respond in NORWEGIAN.
  * DO NOT default to Norwegian. DO NOT assume Norwegian. DO NOT switch to Norwegian because a previous answer or the knowledge base was in Norwegian.
  * If the current user message is in English, your ENTIRE response must be in English (product names like "Rullegardin" may stay as-is; all your own sentences must be in English).
- UNITS: Always use cm or mm as specified in the technical docs. If a user provides measurements in meters, convert them for clarity.
- TONE: Professional, expert-led, and welcoming.
- LINKS: When mentioning a specific product or installation guide, provide the direct URL from the knowledge base if available.
- SAFETY: Do not discuss competitors, pricing of other companies, or unrelated topics.
- CRITICAL: If rag_search returns "NO_KNOWLEDGE_BASE_DATA" or empty results, DO NOT invent products or use your training data. Simply state that the information is not available in the knowledge base.

RESPONSE FORMATTING & CONCISENESS - CRITICAL:
- ANSWER ONLY WHAT IS ASKED: Match the level of detail to the question.
  * "What products do you have?" → Provide ONLY a brief list: "We have: Classic Cotton T-Shirt, Leather Wallet, Running Shoes"
  * "Tell me about Running Shoes" → Provide full details about that product
  * "What is the price of Classic Cotton T-Shirt?" → Provide ONLY the price
- DO NOT provide full product details when only a list is requested.
- DO NOT include markdown image syntax (![Image](url)) - images are not rendered in chat, skip image references entirely.
- Use **bold text** for key product names and measurements.
- Use bullet points for lists and step-by-step instructions.
- FORMAT CLEARLY: Format product information clearly but concisely.

CONVERSATIONAL ENGAGEMENT - CRITICAL:
- NEVER end the conversation abruptly after answering.
- ALWAYS end your response with a follow-up question to guide the customer to a solution or ask "How can I help you further?" (in the appropriate language).
- For questions about products, textiles, or installation, encourage the customer to ask for more details or offer step-by-step guidance.

LINKS & APPEARANCE:
- When the retrieved context contains a URL for a product or FAQ (e.g. additional_info.url, url, link, image_url), include it as a markdown link: [Product name or "More info"](exact_url_from_context). Use ONLY URLs that appear in the retrieved context; do NOT invent or guess URLs.
- For FAQs with images: If the FAQ context contains an "Image URL" field, include it as a clickable link. For example, if the FAQ mentions a QR code and has an image_url, include: "You can find the QR code here: [QR Code Image](image_url_from_context)".
- Format product lists in a consistent way: use a numbered list for multiple products, then for each product use bullet points for Category, Description, key attributes (Price, Max width, Features, etc.), and end with a link when available: [More info](url).
- Example format when a product has a URL in context:
  1. **Product Name**
  - Category: X
  - Description: ...
  - Price: ... (or "Contact for price")
  - [More info](https://visor.no/...)
- Links will be rendered as clickable hyperlinks in the chat. Use the exact URL from the knowledge base.

Be helpful, professional, and expert-led.`;

    // Initialize ChatOpenAI model with function calling
    const model = new ChatOpenAI({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: 'gpt-4o',
      temperature: 0.4,
    }).bindTools([
      {
        type: 'function',
        function: {
          name: 'rag_search',
          description: 'Search the knowledge base (products, FAQs, support tickets, delivery, installation, customer service). MANDATORY: Call this tool for EVERY user message that asks a question or requests information. Do not answer without calling this first. Applies in ALL languages (Norwegian, English, etc.). Use a short search query (e.g. key terms: "tilbud frakt", "offer shipping", "measurements plisse"). If the tool returns "NO_KNOWLEDGE_BASE_DATA", do NOT make up information - state that information is not available.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query about products, FAQs, payment methods, delivery, installation, measurements, specifications, or any customer service related information'
              }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_order_details',
          description: 'Fetch cached order data (status, tracking, delivery date) from the local orders database. Use this FIRST for quick lookups. Requires both order_id and email for security.',
          parameters: {
            type: 'object',
            properties: {
              order_id: {
                type: 'string',
                description: 'The order ID, e.g., 5501 or V-9901'
              },
              email: {
                type: 'string',
                description: 'The customer\'s email address used when placing the order (REQUIRED for security verification)'
              }
            },
            required: ['order_id', 'email']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_order_status',
          description: 'Fetch real-time order information from the CMS API (WordPress/WooCommerce or Magento 2). Use this when you need the most up-to-date order status from the live system. Requires both order_id and email for security.',
          parameters: {
            type: 'object',
            properties: {
              order_id: {
                type: 'string',
                description: 'The unique order number provided to the customer (e.g., \'12345\' or \'V-9901\').'
              },
              email: {
                type: 'string',
                description: 'The email address used when placing the order (REQUIRED for security verification).'
              }
            },
            required: ['order_id', 'email']
          }
        }
      }
    ]);

    // Build messages: system + conversation history + current user message
    const historyMessages = (conversationHistory || []).flatMap((turn) => {
      if (turn.role === 'user') return [new HumanMessage(turn.content)];
      if (turn.role === 'assistant') return [new AIMessage(turn.content)];
      return [];
    });
    const messages = [
      new SystemMessage(systemPrompt),
      ...historyMessages,
      new HumanMessage(message)
    ];

    // Call the model
    let response = await model.invoke(messages);

    // Handle tool calls - check for different response structures
    // In LangChain, tool_calls might be on the response directly or in additional_kwargs
    let toolCalls = [];
    
    if (response.tool_calls && Array.isArray(response.tool_calls)) {
      toolCalls = response.tool_calls;
    } else if (response.toolCalls && Array.isArray(response.toolCalls)) {
      toolCalls = response.toolCalls;
    } else if (response.additional_kwargs?.tool_calls && Array.isArray(response.additional_kwargs.tool_calls)) {
      toolCalls = response.additional_kwargs.tool_calls;
    }

    while (toolCalls && toolCalls.length > 0) {
      const toolResults = [];

      for (const toolCall of toolCalls) {
        try {
          // Handle different tool call structures
          // LangChain tool calls can have different formats:
          // Format 1: { id, type, function: { name, arguments } } - OpenAI format
          // Format 2: { name, args, type, id } - LangChain simplified format
          let functionName, functionArgs, toolCallId;
          
          if (toolCall.name && toolCall.args) {
            // LangChain format: { name, args } - args is already an object
            functionName = toolCall.name;
            functionArgs = toolCall.args;
          } else if (toolCall.function) {
            // OpenAI format: { function: { name, arguments } } - arguments is a string
            functionName = toolCall.function.name;
            functionArgs = toolCall.function.arguments || '{}';
          } else if (toolCall.name) {
            // Fallback: { name, arguments }
            functionName = toolCall.name;
            functionArgs = toolCall.arguments || '{}';
          } else {
            console.error('Tool call structure unexpected:', JSON.stringify(toolCall, null, 2));
            continue;
          }
          
          toolCallId = toolCall.id || toolCall.tool_call_id;

          if (!functionName) {
            console.error('Tool call missing function name:', JSON.stringify(toolCall, null, 2));
            continue;
          }

          let result;
          let args;
          try {
            // args might already be an object (from toolCall.args) or a string (from function.arguments)
            if (typeof functionArgs === 'string') {
              args = JSON.parse(functionArgs);
            } else if (typeof functionArgs === 'object' && functionArgs !== null) {
              args = functionArgs;
            } else {
              args = {};
            }
          } catch (parseError) {
            console.error('Error parsing function arguments:', parseError);
            args = {};
          }

          switch (functionName) {
            case 'rag_search': {
              const ragResult = await ragTool(args);
              const kbHasSubstantive = hasSubstantiveKbContext(ragResult);
              const sensitivePolicyQuery = isSensitivePolicyQuery(message);

              // 1) KB has no real data (empty or only generic \"Fant ikke svar\" contact FAQ)
              //    → prefer ticket-based answer if available.
              if (!kbHasSubstantive) {
                if (!sensitivePolicyQuery) {
                  const ticketAnswer = await answerFromTickets(message);
                  if (ticketAnswer && ticketAnswer.trim().length > 0) {
                    return ticketAnswer;
                  }
                }
              } else {
                // 2) KB has substantive data, but we might still have a strong ticket match:
                //    - high semantic score (>= 0.65; 0.65 allows cross-lingual e.g. EN query vs NO ticket), OR
                //    - user query is a substring of a ticket chunk (e.g. they copied from a ticket).
                if (!sensitivePolicyQuery) {
                  try {
                    const ticketQuery = await expandQueryForSearch(message);
                    const topTickets = await searchTickets(ticketQuery, 5);
                    const topScore = topTickets[0] && typeof topTickets[0].score === 'number' ? topTickets[0].score : null;
                    const strongScore = topScore !== null && topScore >= 0.65;
                    const substringMatch = topTickets.some((doc) => ticketChunkContainsQuery(doc.text, message));
                    if (strongScore || substringMatch) {
                      const ticketAnswer = await answerFromTickets(message);
                      if (ticketAnswer && ticketAnswer.trim().length > 0) {
                        return ticketAnswer;
                      }
                    }
                  } catch (err) {
                    // Fall back to KB result on ticket search failure
                  }
                }
              }

              // If we have substantive KB context but tickets were not clearly better,
              // or ticket search failed, use the RAG result as usual.
              result = ragResult;
              break;
            }
            case 'get_order_details':
              try {
                result = await getOrderDetailsTool(args);
                result = JSON.stringify(result);
              } catch (err) {
                console.error(`[Tool Error] get_order_details failed:`, err.message);
                throw err;
              }
              break;
            case 'get_order_status':
              try {
                result = await getOrderStatusTool(args);
                result = JSON.stringify(result);
              } catch (err) {
                console.error(`[Tool Error] get_order_status failed:`, err.message);
                throw err;
              }
              break;
            default:
              result = `Unknown tool: ${functionName}`;
          }

          toolResults.push({
            tool_call_id: toolCallId,
            role: 'tool',
            name: functionName,
            content: result
          });
        } catch (error) {
          console.error('Error executing tool:', error);
          console.error('Tool call that failed:', JSON.stringify(toolCall, null, 2));
          
          let functionName = 'unknown';
          let toolCallId = 'unknown';
          
          try {
            if (toolCall.function) {
              functionName = toolCall.function.name || 'unknown';
            } else if (toolCall.name) {
              functionName = toolCall.name;
            }
            toolCallId = toolCall.id || toolCall.tool_call_id || 'unknown';
          } catch (e) {
            console.error('Error extracting tool call info:', e);
          }
          
          toolResults.push({
            tool_call_id: toolCallId,
            role: 'tool',
            name: functionName,
            content: `Error: ${error.message}`
          });
        }
      }

      // Add tool results and get next response
      messages.push(response);
      messages.push(...toolResults);
      response = await model.invoke(messages);
      
      // Update toolCalls for next iteration - check all possible locations
      toolCalls = [];
      if (response.tool_calls && Array.isArray(response.tool_calls)) {
        toolCalls = response.tool_calls;
      } else if (response.toolCalls && Array.isArray(response.toolCalls)) {
        toolCalls = response.toolCalls;
      } else if (response.additional_kwargs?.tool_calls && Array.isArray(response.additional_kwargs.tool_calls)) {
        toolCalls = response.additional_kwargs.tool_calls;
      }
    }

    // Return the final response
    const finalText = response.content || 'Jeg beklager, jeg kunne ikke generere et svar.';
    return finalText;
  } catch (error) {
    console.error('Error processing Visor message:', error);
    throw new Error(`Failed to process message: ${error.message}`);
  }
}

module.exports = {
  processVisorMessage
};
