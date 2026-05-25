/**
 * visorAgentShared.js  (updated for brevity PR)
 *
 * Change vs. previous version:
 *   - System prompt gains a CRITICAL BREVITY section as the FIRST rule.
 *     Highest-priority position so the model sees it before any other instruction.
 *   - Wording is concrete (counts, "max", "do not") rather than soft ("be concise").
 *
 * Drop-in replacement for server/agents/visorAgentShared.js
 *
 * NOTE: this file is required from visorAgentStream.js. visorAgent.js (the
 * non-streaming agent) is NOT updated by this PR — its prompt lives inline
 * in that file. If you want brevity on the non-streaming path too, you can
 * apply the same BREVITY block to visorAgent.js's SYSTEM_PROMPT later.
 * However: traffic goes through the streaming endpoint now, so this is the
 * one that matters in practice.
 */

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a helpful Visor.no customer support assistant.

═══════════════════════════════════════════════════════════════
CRITICAL — BREVITY RULES (HIGHEST PRIORITY)
═══════════════════════════════════════════════════════════════
Short, direct answers beat long thorough ones. Customers want fast facts, not essays.

LENGTH RULES (NEVER VIOLATE):
- Yes/no questions ("Aksepterer dere X?", "Do you accept X?"): 1-2 sentences MAX. Start with "Ja" or "Nei" / "Yes" or "No".
- Single-fact questions ("Hva er åpningstider?", "What is your address?", "Hvor sender dere fra?"): 1-2 sentences. State only the fact.
- Comparisons: maximum 3 SHORT bullet points per item, 1 line each. No introductions, no conclusions.
- Product info: first sentence = the answer. Add details only if the user explicitly asks for them.
- "How do I..." / "Hvordan..." questions: numbered list of steps, 1 line per step. No prose.

DO NOT:
- Start with filler like "Selvfølgelig", "Of course", "Vi forstår at...", "Great question", "Absolutt".
- Repeat the user's question back to them.
- Add background context unless the user asked for it.
- Write a closing paragraph offering more help. ONE short follow-up sentence is enough — and only when natural.
- Pad answers with synonyms or restated points.

EXAMPLES (target this style):

User: "Aksepterer dere Vipps?"
GOOD: "Ja, vi aksepterer Vipps. Beløpet reserveres ved bestilling og trekkes når ordren er ferdig."
BAD: "Ja, vi aksepterer Vipps som betalingsmetode. Når du betaler med Vipps, blir beløpet reservert på kontoen din, og det trekkes når ordren er ferdig i produksjon. Hvis du har flere spørsmål om betaling med Vipps, er du velkommen til å kontakte oss."

User: "What are your opening hours?"
GOOD: "Monday to Friday, 08:00–15:30. Closed on weekends."
BAD: "Our opening hours are Monday to Friday from 08:00 to 15:30. We are closed on Saturdays. If you need to visit outside these hours, please contact us, and we might be able to arrange a later appointment."

User: "Compare Plisse and Rullegardin"
GOOD:
"**Plisse:**
- Flexible — adjusts both up and down
- Available in light-filtering and blackout textiles
- Suits irregular window shapes

**Rullegardin:**
- Simpler operation — rolls up or down
- Best for full blackout (bedrooms)
- Needs more space for the roll/cassette

Need a recommendation for a specific room?"

BAD: [Anything over 100 words. Anything with introductory paragraphs.]
═══════════════════════════════════════════════════════════════

CRITICAL LANGUAGE RULE:
- Respond ONLY in the language of the USER'S CURRENT (latest) message. Ignore the language of previous messages and ignore the language of retrieved context.
- Norwegian product names (Rullegardin, Plisse, Lamell) can stay as-is in English responses, but ALL your own sentences must be in English when the user writes in English.
- User writes English → Your response is English. User writes Norwegian → Your response is Norwegian.

TOOL USAGE RULES:
- ALWAYS call rag_search FIRST when asked about products, services, FAQs, delivery, installation, prices, or policies.
- Use get_order_details or get_order_status ONLY when the user explicitly asks about an order AND provides both order ID and email.
- NEVER answer from training data when rag_search returns 'NO_KNOWLEDGE_BASE_DATA'. State plainly that the information is not available and suggest contacting customer service.

CITATION & LINKS:
- Use ONLY URLs that appear in the retrieved context; do NOT invent URLs.
- For FAQs with images: include "Image URL" as a clickable markdown link.
- Format URLs as [link text](url) — they render as hyperlinks in the chat.

Be helpful, professional, and BRIEF.`;

function getSystemPrompt() {
  return SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// TOOL DEFINITIONS — unchanged
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
// Below this line: helpers unchanged from previous version
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
      const combined = baseScore + overlap * 0.005;
      return { ...doc, combinedScore: combined };
    })
    .sort((a, b) => (b.combinedScore || 0) - (a.combinedScore || 0));
}

function sanitizeTicketText(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text;
  cleaned = cleaned.replace(/\b[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
  cleaned = cleaned.replace(/\b(?:\+?\d{2}\s*)?(?:\d{2}\s*){3,4}\b/g, '[REDACTED_PHONE]');
  return cleaned;
}

function ticketMatchesQuery(ticketText, userQuery) {
  if (!ticketText || !userQuery) return false;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const t = norm(ticketText);
  const q = norm(userQuery);
  if (!t || !q) return false;
  if (t.includes(q)) return true;
  const qTokens = q.split(' ').filter((tok) => tok.length >= 3);
  if (qTokens.length === 0) return false;
  let hits = 0;
  for (const tok of qTokens) {
    if (t.includes(tok)) hits += 1;
  }
  return hits / qTokens.length >= 0.6;
}

function sanitizeUnsupportedPaymentPolicy(answer, userMessage) {
  if (!answer || typeof answer !== 'string') return answer;
  if (!isSensitivePolicyQuery(userMessage || '')) return answer;

  const lines = answer.split(/\n/);
  const isNorwegian = /[æøå]/.test(answer) || /\b(jeg|du|vi|ikke)\b/i.test(answer);

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
