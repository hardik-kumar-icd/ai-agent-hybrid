/**
 * Shared helpers for both processVisorMessage() (sync) and
 * processVisorMessageStream() (SSE streaming).
 *
 * This file is created to avoid duplicating logic between the two agent
 * variants. The helpers themselves are the SAME ones that previously lived
 * inside visorAgent.js — they are now extracted here so they can be required
 * from both visorAgent.js and visorAgentStream.js.
 *
 * IMPORTANT: visorAgent.js is updated in this same PR to import its helpers
 * from this file (instead of defining them inline) so behaviour is unchanged.
 */

// ---------------------------------------------------------------------------
// SYSTEM PROMPT — single source of truth for the agent's persona/instructions.
// Copied verbatim from visorAgent.js. If you change the prompt, change it here.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a helpful AI assistant providing product information and customer service.

CRITICAL LANGUAGE RULE - READ THIS FIRST:
- Respond ONLY in the language of the USER'S CURRENT (latest) message. Ignore the language of previous messages in the conversation and ignore the language of the retrieved knowledge base context. If the current user message is in English, your ENTIRE response MUST be in English. If the current user message is in Norwegian, respond in Norwegian.
- The knowledge base may contain Norwegian product names and descriptions (e.g. "Rullegardin", "kassett", "mindre vinduer") – that does NOT change the response language. Always match the CURRENT user message language only.
- If user writes "Which Rullegardin models use a cassette?" → respond in ENGLISH.
- If user writes "Hvilke Rullegardin-modeller bruker kassett?" → respond in Norwegian.

TOOL USAGE RULES:
- ALWAYS call rag_search FIRST when the user asks about products, services, FAQs, delivery, installation, prices, policies, or any factual question.
- Use get_order_details or get_order_status ONLY when the user explicitly asks about an order AND provides (or has previously provided) both an order ID and email.
- NEVER answer from training data when rag_search returns 'NO_KNOWLEDGE_BASE_DATA'. State plainly that the information is not available and suggest contacting customer service.

CITATION & LINKS:
- Use ONLY URLs that appear in the retrieved context; do NOT invent or guess URLs.
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

function getSystemPrompt() {
  return SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// TOOL DEFINITIONS — shared between sync and streaming agents.
// ---------------------------------------------------------------------------
function getToolDefinitions() {
  return [
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
              description: 'The search query about products, FAQs, payment methods, delivery, installation, measurements, specifications, or any customer service related information',
            },
          },
          required: ['query'],
        },
      },
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
              description: 'The order ID, e.g., 5501 or V-9901',
            },
            email: {
              type: 'string',
              description: "The customer's email address used when placing the order (REQUIRED for security verification)",
            },
          },
          required: ['order_id', 'email'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_order_status',
        description: 'Fetch real-time order information from the Magento 2 API. Use this when you need the most up-to-date order status from the live system. Requires both order_id and email for security.',
        parameters: {
          type: 'object',
          properties: {
            order_id: {
              type: 'string',
              description: "The unique order number provided to the customer (e.g., '12345' or 'V-9901').",
            },
            email: {
              type: 'string',
              description: 'The email address used when placing the order (REQUIRED for security verification).',
            },
          },
          required: ['order_id', 'email'],
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// KB context heuristics — when KB returns only a generic contact-info FAQ,
// we treat it as "no real data" and fall back to ticket-based answers.
// (Copied from visorAgent.js — unchanged.)
// ---------------------------------------------------------------------------
function hasSubstantiveKbContext(ragContext) {
  if (!ragContext || typeof ragContext !== 'string' || ragContext.startsWith('NO_KNOWLEDGE_BASE_DATA')) {
    return false;
  }
  const c = ragContext.toLowerCase();
  const isGenericContactOnly =
    c.includes('fant ikke svar') &&
    (c.includes('kundeservice@') || c.includes('696 76 602'));
  if (!isGenericContactOnly) return true;

  const substantiveMarkers = [
    'vipps', 'qr', 'leverings', 'absolute', 'motionblind', 'coulisse', 'tekstilprøve', 'tekstilprøver',
    'nisje', 'montering', 'montasje', 'mål', 'henting', 'økern', 'port 1', 'plisse', 'rullegardin',
    'lamell', 'persienne', 'veiledning', 'fratrekk', 'systembredde', 'image url', 'vips',
  ];
  return substantiveMarkers.some((m) => c.includes(m));
}

// ---------------------------------------------------------------------------
// Sensitive policy detection — block ticket-fallback for these queries because
// historical tickets may have inconsistent or outdated policy answers.
// (Copied from visorAgent.js — unchanged.)
// ---------------------------------------------------------------------------
function isSensitivePolicyQuery(message) {
  if (!message || typeof message !== 'string') return false;
  const m = message.toLowerCase();
  const patterns = [
    /\b(refund|refunder|refundert|reklamasjon|reklamation|complain|complaint)\b/i,
    /\b(return|retur|returnere|returner|returrett)\b/i,
    /\b(warranty|garanti|warrant)\b/i,
    /\b(betalingsvilk[åa]r|payment.{0,15}terms|terms.{0,5}of.{0,5}payment)\b/i,
    /\b(faktura|invoice|payment.{0,5}plan|deferred.{0,5}payment|delbetaling)\b/i,
  ];
  return patterns.some((p) => p.test(m));
}

// ---------------------------------------------------------------------------
// Re-rank Pinecone results by keyword overlap with the original query.
// Helps surface chunks that share specific terms even if cosine is similar.
// (Copied from visorAgent.js — unchanged.)
// ---------------------------------------------------------------------------
function reRankByKeywordOverlap(docs, query) {
  if (!Array.isArray(docs) || !query) return docs;
  const queryTokens = String(query).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const querySet = new Set(queryTokens);

  return docs
    .map((doc) => {
      const text = String(doc?.text || '').toLowerCase();
      let overlap = 0;
      for (const tok of querySet) {
        if (text.includes(tok)) overlap += 1;
      }
      const baseScore = typeof doc?.score === 'number' ? doc.score : 0;
      // Small overlap bonus — preserves cosine ranking but breaks ties usefully.
      const combined = baseScore + overlap * 0.005;
      return { ...doc, combinedScore: combined };
    })
    .sort((a, b) => (b.combinedScore || 0) - (a.combinedScore || 0));
}

// ---------------------------------------------------------------------------
// Sanitize ticket text — strip emails and phone numbers before showing to the
// model so we never leak old customer PII into a new conversation.
// (Copied from visorAgent.js — unchanged.)
// ---------------------------------------------------------------------------
function sanitizeTicketText(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text;
  cleaned = cleaned.replace(/\b[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
  cleaned = cleaned.replace(/\b(?:\+?\d{2}\s*)?(?:\d{2}\s*){3,4}\b/g, '[REDACTED_PHONE]');
  return cleaned;
}

// ---------------------------------------------------------------------------
// True if the user query appears in a ticket chunk. Used to detect when
// a ticket clearly matches the current question.
// (Copied from visorAgent.js — unchanged.)
// ---------------------------------------------------------------------------
function ticketMatchesQuery(ticketText, userQuery) {
  if (!ticketText || !userQuery) return false;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const t = norm(ticketText);
  const q = norm(userQuery);
  if (!t || !q) return false;
  if (t.includes(q)) return true;
  // Partial: at least 60% of query tokens appear in the ticket
  const qTokens = q.split(' ').filter((tok) => tok.length >= 3);
  if (qTokens.length === 0) return false;
  let hits = 0;
  for (const tok of qTokens) {
    if (t.includes(tok)) hits += 1;
  }
  return hits / qTokens.length >= 0.6;
}

// ---------------------------------------------------------------------------
// Strip any unsupported-payment-policy hallucinations from the final answer.
// E.g. the model sometimes claims we offer "Klarna" or "invoice" payments that
// we don't. This is a safety net for sensitive policy queries.
// (Copied from visorAgent.js — unchanged.)
// ---------------------------------------------------------------------------
function sanitizeUnsupportedPaymentPolicy(answer, userMessage) {
  if (!answer || typeof answer !== 'string') return answer;
  if (!isSensitivePolicyQuery(userMessage || '')) return answer;

  const lines = answer.split(/\n/);
  const isNorwegian = /[æøå]/.test(answer) || /\b(jeg|du|vi|ikke)\b/i.test(answer);

  // Lines we filter out — claims about payment plans we don't offer.
  const filtered = lines.filter((line) => {
    const l = line.toLowerCase();
    if (l.includes('klarna')) return false;
    if (l.includes('avbetaling')) return false;
    if (l.includes('delbetaling')) return false;
    if (l.includes('payment plan') && !l.includes('do not')) return false;
    if (l.includes('installment') && !l.includes('do not')) return false;
    if (l.includes('faktura etter')) return false;
    return true;
  });

  const fallback = isNorwegian
    ? 'Jeg har ikke bekreftede detaljer om betalingsvilkår i kunnskapsbasen. Kontakt kundeservice for korrekt betalingsinformasjon.'
    : 'I do not have confirmed payment-policy details in the knowledge base. Please contact customer service for accurate payment terms.';

  const cleaned = filtered.join('\n').trim();
  return cleaned ? `${cleaned}\n\n${fallback}` : fallback;
}

module.exports = {
  getSystemPrompt,
  getToolDefinitions,
  hasSubstantiveKbContext,
  isSensitivePolicyQuery,
  reRankByKeywordOverlap,
  sanitizeTicketText,
  ticketMatchesQuery,
  sanitizeUnsupportedPaymentPolicy,
};
