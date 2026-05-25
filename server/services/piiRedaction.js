/**
 * PII redaction for stored message text.
 *
 * Per the team's privacy decision:
 *   - REDACT emails and phone numbers
 *   - PRESERVE 4+ digit numbers (they're often order IDs — needed for context)
 *
 * The redacted text is what gets stored in messages.content. The raw text
 * is still used at request time for the LLM (we don't want the customer to
 * see "[REDACTED_EMAIL]" in their own message).
 */

// Email pattern — fairly permissive but excludes obvious garbage
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Phone patterns — Norwegian + international formats
// We want to match:
//   - "+47 901 23 456" / "+47 90123456"
//   - "90123456" (bare 8-digit, common Norwegian)
//   - "(47) 901-23-456"
// We DO NOT want to match:
//   - 4-7 digit order IDs ("5501", "1234567")
//   - Dates ("2024-01-15")
//
// Strategy: match digit sequences with optional separators where the total
// digit count is 8 or more. We use two separate patterns and combine results.
const PHONE_PATTERN_INTL = /\+\d{1,3}[\s.-]?(?:\d[\s.-]?){6,14}\d/g;       // +CC ... digits
const PHONE_PATTERN_LOCAL = /\b\d{8,15}\b/g;                                // bare 8-15 digit sequence
const PHONE_PATTERN_SPACED = /\b(?:\d{2,4}[\s.-]){2,}\d{2,4}\b/g;           // "90 12 34 56" style

/**
 * Redact emails and phones from a string.
 *
 * @param {string} text
 * @returns {string} redacted version
 */
function redactPII(text) {
  if (!text || typeof text !== 'string') return text;

  let redacted = text;

  // Pass 1: emails
  redacted = redacted.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');

  // Pass 2a: international phones (+47 ...)
  redacted = redacted.replace(PHONE_PATTERN_INTL, '[REDACTED_PHONE]');

  // Pass 2b: spaced/separated phones ("90 12 34 56")
  redacted = redacted.replace(PHONE_PATTERN_SPACED, (match) => {
    const digitCount = (match.match(/\d/g) || []).length;
    if (digitCount < 8) return match;
    // Skip if looks like a date (YYYY-MM-DD style)
    if (/^\d{4}[-/.]?\d{1,2}[-/.]?\d{1,2}$/.test(match)) return match;
    return '[REDACTED_PHONE]';
  });

  // Pass 2c: bare 8+ digit sequences — phones, NOT order IDs
  // Order IDs are typically 4-7 digits; phones are 8+.
  redacted = redacted.replace(PHONE_PATTERN_LOCAL, (match) => {
    if (match.length < 8) return match;
    // Skip if it's a 4-digit year inside a longer sequence (unlikely with \b)
    return '[REDACTED_PHONE]';
  });

  return redacted;
}

/**
 * Quick check: does a string contain PII?
 */
function containsPII(text) {
  if (!text || typeof text !== 'string') return false;
  const hasEmail = EMAIL_PATTERN.test(text); EMAIL_PATTERN.lastIndex = 0;
  if (hasEmail) return true;
  const hasIntl = PHONE_PATTERN_INTL.test(text); PHONE_PATTERN_INTL.lastIndex = 0;
  if (hasIntl) return true;
  const hasLocal = PHONE_PATTERN_LOCAL.test(text); PHONE_PATTERN_LOCAL.lastIndex = 0;
  if (hasLocal) return true;
  return false;
}

module.exports = {
  redactPII,
  containsPII,
};
