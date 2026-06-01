/**
 * cleanTicketsJson.js
 *
 * Reads the phpMyAdmin export of mst_helpdesk_ticket and produces
 * tickets_cleaned.jsonl — one ticket per line, ready for summarization.
 *
 * Pipeline:
 *   1. Strip phpMyAdmin's JS comment header
 *   2. Parse JSON array
 *   3. Filter: status_id == '3' (Lukket), search_index non-empty, reply_cnt > 0
 *   4. Redact PII per-row using customer_email + customer_name as exact strings,
 *      plus pattern-based: phone numbers, postal codes, additional emails
 *   5. Strip email reply headers, AWS tracking URLs, HTML fragments
 *   6. Collapse whitespace
 *   7. Truncate search_index at MAX_CONTENT_CHARS (default 6000) for summarizer
 *
 * Output: tickets_cleaned.jsonl  (one ticket per line)
 * Stats:  tickets_cleaning_report.json
 *
 * Usage:
 *   node server/scripts/cleanTicketsJson.js [path]
 *
 * Default: server/scripts/data/mst_helpdesk_ticket.json
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_INPUT = path.join(__dirname, 'data', 'mst_helpdesk_ticket.json');
const MAX_CONTENT_CHARS = 6000;  // truncate threads longer than this for summarizer

// Department + channel lookup tables (from Visor's Mirasvit setup)
const DEPARTMENT_NAMES = {
  '1': 'Salg',
  '2': 'Support',
  '3': 'Reklamasjon',
  '4': 'Transport',
  '5': 'Befaring',
};

const STATUS_NAMES = {
  '1': 'Åpen',
  '2': 'Behandles',
  '3': 'Lukket',
  '4': 'Ny ubehandlet',
};

// ============================================================
// File reading: phpMyAdmin export has JS comments before the JSON array
// ============================================================
function parsePhpMyAdminJson(rawText) {
  const bracketPos = rawText.indexOf('[');
  if (bracketPos === -1) {
    throw new Error("Couldn't find JSON array opening bracket in input file");
  }
  const jsonText = rawText.slice(bracketPos);
  return JSON.parse(jsonText);
}

// ============================================================
// PII redaction
// ============================================================

// Norwegian phone: optional +47/0047 prefix, then 8 digits starting with 2-9
// Common formats: 41549630, 415 49 630, +47 415 49 630, 0047 415 49 630
const PHONE_PATTERN = /(?:\+47\s?|0047\s?)?\b[2-9]\d{1}\s?\d{2}\s?\d{2}\s?\d{2}\b/g;

// Generic email pattern (catches any not already redacted by customer_email)
const EMAIL_PATTERN = /\b[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

// Norwegian postal code: 4 digits, often followed by city in caps
// e.g. "7224 Melhus" or "0150 OSLO"
const POSTAL_CODE_PATTERN = /\b\d{4}\b(?=\s+[A-ZÆØÅ][a-zæøåA-ZÆØÅ]+)/g;

// Order/reference numbers — anything that looks like "ordre 12345" or "order_id 12345"
const ORDER_REF_PATTERN = /\b(ordre|order|ordrenummer|ordrenr|bestilling)[\s:#]*\d{6,10}\b/gi;

// Magento order IDs alone (8-digit standalone numbers near order context — risky to redact aggressively)
// We leave standalone numbers alone to avoid redacting product dimensions like "30 305 cm"

// AWS email tracking URLs — long awstrack.me URLs that appear in email replies
const AWS_TRACKING_URL = /https?:\/\/[a-z0-9.-]+\.awstrack\.me\/[^\s)"']+/gi;

// Standard email reply quote headers: From:/Sent:/To:/Subject: block with separator lines
const EMAIL_REPLY_HEADER = /(?:^|\n)\s*-{5,}\s*\n\s*From:.*?(?=\n\n|\n[A-ZÆØÅa-zæøå][^\n]{20})/gs;

// Simpler quote-headers without leading dashes
const QUOTED_HEADER_BLOCK = /(?:^|\n)\s*(?:From|Fra):\s*[^\n]+\n\s*(?:Sent|Sendt):\s*[^\n]+\n\s*(?:To|Til):\s*[^\n]+\n\s*(?:Subject|Emne):\s*[^\n]+/g;

// HTML tag fragments
const HTML_TAG_PATTERN = /<[^>]+>/g;
const HTML_HREF_LEAK = /href="[^"]*"\s*>/g;
const HTML_ENTITY_PATTERN = /&(nbsp|amp|lt|gt|quot|#039|#?[a-z0-9]+);/gi;

// Multiple whitespace
const MULTI_WHITESPACE = /\s+/g;

function redactPii(text, customerName, customerEmail) {
  if (!text || typeof text !== 'string') return '';

  let out = text;

  // 1. Customer-specific replacements (use the row's known PII to do exact-match redaction)
  if (customerEmail && customerEmail.trim()) {
    const escapedEmail = customerEmail.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escapedEmail, 'gi'), '[CUSTOMER_EMAIL]');
  }

  if (customerName && customerName.trim() && customerName.trim().length >= 3) {
    // Avoid redacting common words mistaken for names (Norwegian first names sometimes
    // overlap with common nouns). Only redact 3+ character names with word boundaries.
    const escapedName = customerName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escapedName}\\b`, 'gi'), '[CUSTOMER]');

    // Also redact first-name-only mentions (everything before first space)
    const firstName = customerName.trim().split(/\s+/)[0];
    if (firstName && firstName.length >= 3) {
      const escapedFirst = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`\\b${escapedFirst}\\b`, 'gi'), '[CUSTOMER]');
    }
  }

  // 2. Pattern-based PII (catches anything missed by per-row redaction)
  out = out.replace(EMAIL_PATTERN, '[EMAIL]');
  out = out.replace(PHONE_PATTERN, '[PHONE]');
  out = out.replace(POSTAL_CODE_PATTERN, '[POSTCODE]');
  out = out.replace(ORDER_REF_PATTERN, '[ORDER_REF]');

  return out;
}

// ============================================================
// Noise stripping (email artifacts, HTML, tracking URLs)
// ============================================================
function stripNoise(text) {
  if (!text) return '';

  let out = text;

  // Strip AWS tracking URLs FIRST (they're long and break other patterns)
  out = out.replace(AWS_TRACKING_URL, '[TRACKING_URL]');

  // Strip email reply quote blocks
  out = out.replace(EMAIL_REPLY_HEADER, '\n');
  out = out.replace(QUOTED_HEADER_BLOCK, '\n');

  // Strip HTML tags and leaked href fragments
  out = out.replace(HTML_HREF_LEAK, ' ');
  out = out.replace(HTML_TAG_PATTERN, ' ');

  // Decode common HTML entities
  out = out.replace(HTML_ENTITY_PATTERN, ' ');

  // Strip horizontal rules / separator lines that appear in email replies
  out = out.replace(/^[-=_*]{4,}$/gm, '');

  // Collapse whitespace
  out = out.replace(MULTI_WHITESPACE, ' ').trim();

  return out;
}

// ============================================================
// Per-ticket processing
// ============================================================
function processTicket(row) {
  const ticketId = row.ticket_id;
  const code = row.code || '';
  const subject = (row.subject || '').trim();
  const statusId = row.status_id;
  const departmentId = row.department_id;
  const channel = row.channel || '';
  const customerEmail = row.customer_email || '';
  const customerName = row.customer_name || '';
  const searchIndex = row.search_index || '';
  const replyCnt = parseInt(row.reply_cnt, 10) || 0;
  const createdAt = row.created_at || '';
  const orderId = row.order_id || '';

  // Filtering rules
  if (statusId !== '3') {
    return { skip: true, reason: 'not_closed' };
  }
  if (!searchIndex || !searchIndex.trim()) {
    return { skip: true, reason: 'empty_search_index' };
  }
  if (replyCnt < 1) {
    return { skip: true, reason: 'no_replies' };
  }
  // Skip extremely short tickets (< 50 chars) — almost always single-word junk
  if (searchIndex.trim().length < 50) {
    return { skip: true, reason: 'too_short' };
  }

  // Process content
  let content = stripNoise(searchIndex);
  content = redactPii(content, customerName, customerEmail);

  // Also redact PII from subject (in case customer put email/phone in subject line)
  const cleanSubject = redactPii(subject, customerName, customerEmail);

  // Truncate at MAX_CONTENT_CHARS for summarizer budget
  let truncated = false;
  if (content.length > MAX_CONTENT_CHARS) {
    // Try to truncate at sentence boundary
    const slice = content.slice(0, MAX_CONTENT_CHARS);
    const lastBoundary = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? ')
    );
    if (lastBoundary > MAX_CONTENT_CHARS * 0.7) {
      content = slice.slice(0, lastBoundary + 1) + ' [TRUNCATED]';
    } else {
      content = slice + ' [TRUNCATED]';
    }
    truncated = true;
  }

  // Final sanity: content must still have meaning after redaction
  if (content.length < 30) {
    return { skip: true, reason: 'too_short_after_cleaning' };
  }

  return {
    cleaned: {
      ticket_id: ticketId,
      code,
      subject: cleanSubject,
      department_id: departmentId,
      department_name: DEPARTMENT_NAMES[departmentId] || `unknown_${departmentId}`,
      channel,
      reply_cnt: replyCnt,
      created_at: createdAt,
      order_id: orderId && orderId !== '0' ? orderId : null,
      content,
      content_was_truncated: truncated,
    },
  };
}

// ============================================================
// Main
// ============================================================
async function main() {
  const inputPath = process.argv[2] || DEFAULT_INPUT;
  console.log(`📄 Reading: ${inputPath}`);

  if (!fs.existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf-8');
  console.log(`✅ Read ${raw.length} chars`);

  let tickets;
  try {
    tickets = parsePhpMyAdminJson(raw);
  } catch (err) {
    console.error(`❌ Failed to parse JSON: ${err.message}`);
    process.exit(1);
  }
  console.log(`✅ Parsed ${tickets.length} ticket records`);

  // Process each
  const cleaned = [];
  const skipReasons = {};
  let processed = 0;

  for (const row of tickets) {
    processed += 1;
    const result = processTicket(row);
    if (result.skip) {
      skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
    } else {
      cleaned.push(result.cleaned);
    }
    if (processed % 2000 === 0) {
      console.log(`  ... processed ${processed}/${tickets.length}`);
    }
  }

  // Write cleaned JSONL
  const outDir = path.dirname(inputPath);
  const cleanedPath = path.join(outDir, 'tickets_cleaned.jsonl');
  const reportPath = path.join(outDir, 'tickets_cleaning_report.json');

  fs.writeFileSync(
    cleanedPath,
    cleaned.map((t) => JSON.stringify(t)).join('\n') + '\n'
  );

  // Stats
  const dept_dist = {};
  for (const t of cleaned) {
    dept_dist[t.department_name] = (dept_dist[t.department_name] || 0) + 1;
  }

  const truncatedCount = cleaned.filter((t) => t.content_was_truncated).length;

  const report = {
    generated_at: new Date().toISOString(),
    input_path: inputPath,
    output_path: cleanedPath,
    total_input_records: tickets.length,
    cleaned_count: cleaned.length,
    skipped: skipReasons,
    truncated_count: truncatedCount,
    department_distribution: dept_dist,
    avg_content_chars:
      cleaned.length > 0
        ? Math.round(
            cleaned.reduce((s, t) => s + t.content.length, 0) / cleaned.length
          )
        : 0,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Summary
  console.log('');
  console.log(`✅ Cleaned ${cleaned.length} tickets`);
  console.log(`⏭️  Skipped:`);
  for (const [reason, count] of Object.entries(skipReasons)) {
    console.log(`    ${reason}: ${count}`);
  }
  console.log(`📏 Truncated (>6000 chars): ${truncatedCount}`);
  console.log('');
  console.log('Department distribution:');
  for (const [dept, count] of Object.entries(dept_dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dept.padEnd(15)} ${count}`);
  }
  console.log('');
  console.log(`📝 Wrote: ${cleanedPath}`);
  console.log(`📝 Wrote: ${reportPath}`);
  console.log('');
  console.log('Next: node server/scripts/summarizeTickets.js --limit 100');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
}

module.exports = { main, processTicket, redactPii, stripNoise };
