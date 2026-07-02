/**
 * Query Classifier — pure JS heuristics that route incoming queries to one of:
 *
 *   'fast_path'  → clearly an info/FAQ question; skip the LLM router and go
 *                  straight to rag_search + streaming synthesis
 *   'order'      → order lookup intent (handled by existing tools)
 *   'complex'    → ambiguous, multi-part, follow-up, or product comparison;
 *                  use the full LLM tool-routing path (current behaviour)
 *
 * Design principles:
 *   - NO LLM call here. The whole point is to skip the ~800ms router LLM.
 *   - BIAS TOWARD 'complex' on borderline cases. Misrouting to fast-path can
 *     degrade quality; misrouting to complex is just "same as today".
 *   - Stateless and pure. Easy to unit-test, easy to tune.
 *
 * Heuristics (in priority order):
 *
 *   1. Order detect regex → 'order'
 *   2. Conversation context references ("the product", "den", "det",
 *      "previous", "above") → 'complex' (needs history)
 *   3. Multi-part question (commas + question marks, "og", "and", "also",
 *      multiple "?") → 'complex'
 *   4. Product comparison/recommendation keywords → 'complex'
 *   5. Short single-sentence question with FAQ-style interrogative
 *      (Hva/Hvor/Hvordan/Når/Hvilke/What/How/Where/When/Which/Why/Can/Do) → 'fast_path'
 *   6. Single-sentence statement with implicit FAQ intent (e.g. "åpningstider",
 *      "kontakt", "telefonnummer", "frakt", "levering", "opening hours",
 *      "contact", "phone", "shipping") → 'fast_path'
 *   7. Anything else → 'complex'
 *
 * Returns: 'fast_path' | 'order' | 'complex'
 */

// ---- Order intent ----
const ORDER_DETECT_REGEX = /\b(ordrestatus|order status|where is my order|hvor er min ordre|track order|spor ordre|order number|ordrenummer|order id|orderid|my order|min ordre|ordre\s+\d{4,}|\d{4,}\s+ordre|bestilling\s+\d{4,}|\d{4,}\s+bestilling|når kommer|when.*order|levering.*ordre|ordre.*levering|forvente.*ordre|ordre.*forvente|status.*ordre|ordre.*status)\b/i;
// ---- Context-dependent words (need history → complex) ----
const CONTEXT_REFERENCE_REGEX = /\b(den|det|denne|disse|the (product|model|item|one)|that (product|model|item|one)|previous|above|tidligere|over|nevnt|mentioned|sist|last)\b/i;

// ---- Comparison / recommendation (richer answers needed → complex) ----
const COMPARISON_KEYWORDS_REGEX = /\b(vs|versus|compare|comparison|sammenlign|forskjell|difference|differance|recommend|recommendation|anbefal|best|beste|hvilken er bedre|which is better|or|eller)\b/i;

// ---- Multi-part question heuristics ----
function isMultiPart(message) {
  // Multiple question marks
  if ((message.match(/\?/g) || []).length >= 2) return true;
  // Conjunction between two interrogative clauses (with or without comma)
  // e.g. "Hva er X og hvor er Y?" / "What is X and how do I Y?"
  if (/\b(hva|hvor|hvordan|når|hvilke|kan|er|har)\b.{0,80}\b(og|eller)\b.{0,80}\b(hva|hvor|hvordan|når|hvilke|kan|er|har)\b/i.test(message)) return true;
  if (/\b(what|where|how|when|which|can|is|are|do|does|have)\b.{0,80}\b(and|or|also)\b.{0,80}\b(what|where|how|when|which|can|is|are|do|does|have)\b/i.test(message)) return true;
  // Comma + conjunction + question mark
  if (/,.*\b(og|and|also|i tillegg|in addition)\b.*\?/i.test(message)) return true;
  // Very long messages (>30 words) are almost always multi-part
  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount > 30) return true;
  return false;
}

// ---- FAQ-style interrogatives (short questions) ----
// Norwegian: Hva, Hvor, Hvordan, Når, Hvilke(t/n), Kan, Har, Gjør
// English: What, Where, How, When, Which, Why, Can, Do, Does, Is, Are, Have
const FAQ_INTERROGATIVE_REGEX = /^(\s*)(hva|hvor|hvordan|når|hvilke[tn]?|kan|har|gjør|er det|finnes det|what|where|how|when|which|why|can|do|does|is|are|have|has|will|would|should|could)\b/i;

// ---- Implicit FAQ topics (single-word/topic queries) ----
// These are common Norwegian/English support topics that map 1:1 to FAQs.
const IMPLICIT_FAQ_TOPICS_REGEX = /\b(åpningstider|opening hours|kontakt|kontaktinformasjon|contact|telefonnummer|telefon|phone|phone number|frakt|fraktkostnader|shipping|shipping cost|levering|leveringstid|delivery|delivery time|betaling|payment|payment methods|betalingsmetoder|vipps|adresse|address|kundeservice|customer service|garanti|warranty|returer|returns|retur|return|åpent|open|opening|closed|stengt|telefon|email|e-post|hjelp|help|support)\b/i;

// ---- Product detail markers (single-product info → still fast-path if short) ----
// "Tell me about Plisse" is FAQ-like enough; "Compare Plisse and Rullegardin" is not.
const SINGLE_PRODUCT_DETAIL_REGEX = /^(\s*)(tell me about|tell about|hva er|hvad er|info om|info on|details om|details on|about)\b/i;

/**
 * Classify a user message.
 *
 * @param {string} message - The user's current message
 * @param {Array<{role:string,content:string}>} [history] - Recent conversation
 * @returns {'fast_path' | 'order' | 'complex'}
 */
const EMAIL_REGEX = /^[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const ORDER_NUMBER_IN_HISTORY_REGEX = /\b\d{4,}\b/;

function classifyQuery(message, history = []) {
  if (!message || typeof message !== 'string') return 'complex';

  const m = message.trim();
  if (m.length === 0) return 'complex';

  // 1) Order intent — always wins, has its own toolchain
  if (ORDER_DETECT_REGEX.test(m)) return 'order';

  // 1b) Email-only follow-up after an order question in history
  // If the user just typed an email and recent history contains an order number,
  // this is the email follow-up to a "what is my order status" question.
  if (EMAIL_REGEX.test(m) && history.length > 0) {
    const recentHistory = history.slice(-4).map(h => h.content || '').join(' ');
    if (ORDER_DETECT_REGEX.test(recentHistory) || ORDER_NUMBER_IN_HISTORY_REGEX.test(recentHistory)) {
      return 'order';
    }
  }

  // 2) References previous turn → needs full conversation context
  //    (Only treat as complex if history exists; otherwise the reference is moot)
  if (history.length > 0 && CONTEXT_REFERENCE_REGEX.test(m)) return 'complex';

  // 3) Multi-part questions → complex
  if (isMultiPart(m)) return 'complex';

  // 4) Comparison/recommendation → complex
  if (COMPARISON_KEYWORDS_REGEX.test(m)) return 'complex';

  // 5) Short FAQ-style interrogative
  const wordCount = m.split(/\s+/).length;
  if (wordCount <= 15 && FAQ_INTERROGATIVE_REGEX.test(m)) return 'fast_path';

  // 6) Implicit FAQ topic word in short query
  if (wordCount <= 10 && IMPLICIT_FAQ_TOPICS_REGEX.test(m)) return 'fast_path';

  // 7) Single-product detail request — short and direct
  if (wordCount <= 10 && SINGLE_PRODUCT_DETAIL_REGEX.test(m)) return 'fast_path';

  // Default → complex (bias toward safety)
  return 'complex';
}

module.exports = {
  classifyQuery,
  // exported for testing
  _internals: {
    ORDER_DETECT_REGEX,
    CONTEXT_REFERENCE_REGEX,
    COMPARISON_KEYWORDS_REGEX,
    FAQ_INTERROGATIVE_REGEX,
    IMPLICIT_FAQ_TOPICS_REGEX,
    SINGLE_PRODUCT_DETAIL_REGEX,
    isMultiPart,
  },
};
