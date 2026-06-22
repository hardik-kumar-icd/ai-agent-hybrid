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
- For ANY question about Visor.no — products, services, FAQs, delivery, payments, installation, prices, policies — call AT LEAST ONE search_* tool FIRST. Do not answer from training data.
- Choose the right tool for the question type:
  - search_faq:      policies, processes, how-to, opening hours, payment methods, returns
  - search_products: authoritative product specs (dimensions, textiles, prices, comparisons)
  - search_tickets:  precedent for unusual situations, complaints, defects, edge cases (last resort)
- You may call multiple search tools in one turn when the question spans categories.
- Use get_order_details or get_order_status ONLY when the user explicitly asks about an order AND provides both order ID and email.
- NEVER invent product specifications. If a search tool returns 'NO_KNOWLEDGE_BASE_DATA', state plainly that the information is not available in the knowledge base, and suggest contacting customer service at kundeservice@visor.no.

ORDERING, MEASURING & CONFIGURATION (combine sources and guide step by step):
When the user asks how to measure, install, size, mount, configure, or order a product, run a short guided flow. Call search_faq (measuring/ordering guide) AND search_products (the specific product and its page URL) in the SAME turn, ask ONE question at a time, and never guess.
When the user asks how to ORDER (bestille) a product, do NOT give a generic checkout walkthrough that says "enter exact measurements" or "uten fratrekk". Ordering requires correct measuring first: handle the niche-vs-front question and the 5 mm niche width deduction, then tell them to enter the resulting production size on the product page and finish the order there. Always include the product's page link when a specific product is identified.
Guided flow:
- Product: if already clear from the conversation, use it; otherwise ask which product (roller/rullegardin, pleated/plisse, slatted/lamell, venetian/persienne).
- Mount: ask whether it is mounted inside the recess/niche (i nisje) or in front / on the wall (utenpaa).
- If slatted AND recess: ask whether it runs to the floor or is a window.
- Then compile the measuring guidance from the answers (rules below) and finish with the order link.
Measuring rules (authoritative - NEVER tell a customer to measure "without deduction" / "uten fratrekk"):
- The measurements the customer gives are the PRODUCTION measurements (system width and system height); Visor makes NO further deductions, so the customer applies the clearance.
- Recess/niche: deduct 5 mm (0.5 cm) from the width (all products).
- Slatted (lamell) is the ONLY product that also needs a height deduction in a niche: about 10-15 mm (1-1.5 cm) for a window, about 20-25 mm (2-2.5 cm) to the floor. Take the exact figure from the product's measuring FAQ.
- Front / wall: no width deduction (may need wall brackets; slatted may add width to park slats beside the opening).
- Work in cm (one decimal); convert mm/m; repeat width, height, mount type and operating side back for confirmation.
Finish:
- Point the customer to that product's "How to measure and install" page and measuring video.
- Then give the order link: "When you're ready, you can order it here: [URL]" using the product or category URL from the retrieved context. NEVER invent a URL; if none was retrieved, tell them where to find it instead.

PAYMENT METHODS (AUTHORITATIVE — do not invent or hallucinate):
Visor accepts ONLY these payment methods:
- Credit card Visa and Mastercard
- Vipps
- Klarna
- Walley - Betalingsmiddel faktura
- Walley - Delbetaling

Visor does NOT accept: American Express (Amex), PayPal, Apple Pay, Google Pay, cryptocurrency, bank transfer, cash, or any other method not on the accepted list above.

When asked about payment methods, answer from THIS list, not from search_faq results which may be outdated. If a customer asks about a specific method NOT on the accepted list, clearly say "Nei, vi aksepterer ikke [method]" and suggest one of the accepted methods instead.

SENSITIVE TOPICS (NEVER use search_tickets for these):
- Returns, refunds, exchanges, right-of-withdrawal (angrerett)
- Warranty terms, defects, reklamasjon
- Customer data / GDPR / privacy
- Payment methods (use the PAYMENT METHODS block above)

For sensitive topics: call search_faq first. If FAQ confidence is low, plainly state the policy is not in the knowledge base and suggest contacting kundeservice@visor.no. NEVER answer sensitive-topic questions from search_tickets — ticket history may contain outdated or wrong policy information.

CITATION & LINKS:
- Use ONLY URLs that appear in the retrieved context; do NOT invent URLs.
- For FAQs with images: include "Image URL" as a clickable markdown link.
- Format URLs as [link text](url) — they render as hyperlinks in the chat.

Be helpful, professional, and BRIEF.`;

/**
 * Get the system prompt, optionally biased by the widget's entry-point category.
 *
 * @param {object} [opts]
 * @param {'faqs'|'product'|'free'} [opts.category] - Which widget button the user clicked
 * @returns {string} The system prompt with optional category hint appended
 */
function getSystemPrompt(opts = {}) {
  const category = opts.category || 'free';
  const hints = {
    faqs: `

USER CONTEXT (from widget):
The user clicked the "FAQs" button. They likely want a policy/process/how-to answer.
Call search_faq FIRST. Only call search_products if the question turns out to require
specific product specs. Only call search_tickets if neither FAQ nor product search returns
a confident answer.`,
    product: `

USER CONTEXT (from widget):
The user clicked the "Product Info" button. They want product-specific information.
Call search_products FIRST. Only call search_faq if the question is really about policy
rather than a product. Only call search_tickets if both fail.`,
    order: `

USER CONTEXT (from widget):
The user clicked the "Order Status" button or asked an order question. This category
is normally handled by direct-dispatch at the route level before reaching this prompt,
so if you're seeing it here something fell through. When the user's message contains
both an order_id and an email (or the [Context: ...] annotation shows them), call
get_order_status IMMEDIATELY for live Magento data. Do NOT call get_order_details
(its data is a cache and may be stale). Do NOT refuse — the order_id and email have
already been validated upstream.`,
    free: '',
  };
  return SYSTEM_PROMPT + (hints[category] || '');
}

// ---------------------------------------------------------------------------
// TOOL DEFINITIONS — Drop 2 typed tools (replaces single rag_search)
// ---------------------------------------------------------------------------
function getToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'search_faq',
        description: 'Search Visor.no FAQs for POLICY, PROCESS, and HOW-TO questions: payment methods, delivery times, returns, measuring guides, mounting instructions, customer service hours, ordering process, opening hours, contact details. Use this for "how do I...", "do you accept...", "what is your..." questions. DOES NOT contain authoritative product dimensions or specifications — use search_products for those.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Concise search query in the user's language" },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_products',
        description: 'Search the Visor.no PRODUCT CATALOG for authoritative product information: exact dimensions (min/max width and height in cm), textile options and groups, color and profile choices, prices, delivery time, slope-window suitability, motorization, product comparisons. ALWAYS use this for any question depending on specific product specs. Returns structured product data sourced from Magento.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Concise search query in the user's language" },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_tickets',
        description: "Search HISTORICAL customer support conversations for precedent on unusual situations, complaints, defects, warranty claims, edge cases, atypical mounting scenarios, or customer-language phrasings that don't match FAQ or product topics directly. Tickets are HISTORICAL and may be outdated — never treat as authoritative for current product specs or policies. Use as a LAST RESORT when search_faq and search_products do not give a confident answer.",
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Concise search query in the user's language" },
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
            order_id: { type: 'string', description: 'The order ID, e.g., 5501 or V-9901' },
            email: { type: 'string', description: "The customer's email address used when placing the order (REQUIRED for security verification)" },
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
            order_id: { type: 'string', description: "The unique order number provided to the customer (e.g., '12345' or 'V-9901')." },
            email: { type: 'string', description: 'The email address used when placing the order (REQUIRED for security verification).' },
          },
          required: ['order_id', 'email'],
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Helper functions — unchanged from previous version
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
  return patterns.some((p) => p.test(message));
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

module.exports = {
  getSystemPrompt,
  getToolDefinitions,
  hasSubstantiveKbContext,
  isSensitivePolicyQuery,
  reRankByKeywordOverlap,
  sanitizeTicketText,
  ticketMatchesQuery,
};
