/**
 * summarizeTickets.js
 *
 * Reads tickets_cleaned.jsonl, calls GPT-4o-mini per ticket to produce a
 * structured summary, writes tickets_summarized.jsonl.
 *
 * Features:
 *   - Resumable: writes one line at a time, can be killed and restarted.
 *     On startup, reads the existing output file and skips already-summarized ticket_ids.
 *   - Skip detection: when the LLM outputs TOPIC: SKIP, no chunk is created.
 *   - Per-ticket retries on transient API errors (up to 3 attempts).
 *   - Pre-flight mode: --limit N to summarize first N for inspection.
 *
 * Cost (full run, 15.9k tickets at GPT-4o-mini):
 *   ~$1.08 input + ~$1.91 output = ~$3 total
 *   ~2-3 hours wall-clock (rate-limit bound at default 500 RPM)
 *
 * Usage:
 *   node server/scripts/summarizeTickets.js [--limit N] [--input path] [--output path]
 *
 * Flags:
 *   --limit N      Process only the first N un-summarized tickets (pre-flight mode)
 *   --input path   Custom input path (default: tickets_cleaned.jsonl)
 *   --output path  Custom output path (default: tickets_summarized.jsonl)
 *   --concurrency  Parallel API calls (default 5)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const fs = require('fs');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_INPUT = path.join(DATA_DIR, 'tickets_cleaned.jsonl');
const DEFAULT_OUTPUT = path.join(DATA_DIR, 'tickets_summarized.jsonl');

const MODEL = 'gpt-4o-mini';
const MAX_TOKENS_OUT = 350;
const DEFAULT_CONCURRENCY = 5;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

// CLI arg parsing
function getArg(name, defaultValue = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return defaultValue;
  return process.argv[idx + 1];
}

const LIMIT = parseInt(getArg('--limit', '0'), 10) || 0;
const INPUT = getArg('--input', DEFAULT_INPUT);
const OUTPUT = getArg('--output', DEFAULT_OUTPUT);
const CONCURRENCY = parseInt(getArg('--concurrency', String(DEFAULT_CONCURRENCY)), 10);

// ============================================================
// Summarization prompt
// ============================================================
const SYSTEM_PROMPT = `You are summarizing Norwegian customer support tickets from Visor.no (a window blinds e-commerce store) into a structured knowledge base entry. Tickets are conversations between customers and support agents about products like Plissegardin, Rullegardin, Lamellgardin, Persienne, Liftgardin, and curtain accessories.

Your job: extract REUSABLE KNOWLEDGE from the conversation — facts that would help answer similar future customer questions.

OUTPUT FORMAT (Norwegian, exactly as shown):

TOPIC: <3-7 word descriptor of the issue/question>
PRODUCT_FAMILY: <Plissegardin|Rullegardin|Lamellgardin|Persienne|Liftgardin|Gardin|Motionblinds|Annet>
QUESTION: <1-2 sentences. What was the customer asking about? Strip emotional content.>
RESOLUTION: <1-3 sentences. How was it resolved? What did the agent say or do?>
KEY_FACTS:
- <factual bullet 1: measurements, prices, product details, technical specs, policies, links>
- <factual bullet 2>
- <factual bullet 3 — usually 3 to 5 bullets total, max 7>
TAGS: <comma-separated topical keywords, lowercase, no spaces in keywords>

CRITICAL RULES:
1. Output in NORWEGIAN to match the source data.
2. NO customer-identifying info (names, emails, phones) — these are already redacted as [CUSTOMER], [EMAIL], [PHONE].
3. NO pleasantries ("hilsen", "takk for henvendelsen") or emotional content.
4. KEY_FACTS must be FACTS that would help future customers, not summary of THIS specific case.
5. If the ticket is about a specific order delivery/refund/case with NO general value (e.g., "where is my order", "my order arrived broken, please send a new one"), output exactly:
   TOPIC: SKIP
   ...and nothing else.
6. If you can't determine PRODUCT_FAMILY, use "Annet".
7. Keep RESOLUTION factual. If the agent gave a price like "Kr 867", include it. If they linked to a page, include the page name.`;

function buildUserPrompt(ticket) {
  return `Ticket ID: ${ticket.ticket_id}
Code: ${ticket.code}
Department: ${ticket.department_name}
Channel: ${ticket.channel}
Subject: ${ticket.subject || '(none)'}

Thread content:
${ticket.content}`;
}

// ============================================================
// OpenAI API client (using built-in fetch in Node 18+)
// ============================================================
async function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY missing from environment');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS_OUT,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    const err = new Error(`OpenAI API ${response.status}: ${errBody.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`OpenAI returned no content: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return {
    text: content,
    usage: data.usage || {},
  };
}

async function summarizeWithRetry(ticket) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await callOpenAI(SYSTEM_PROMPT, buildUserPrompt(ticket));
      return result;
    } catch (err) {
      lastErr = err;
      // Don't retry on auth errors
      if (err.status === 401 || err.status === 403) throw err;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.error(`  ⚠️  ticket ${ticket.ticket_id} attempt ${attempt} failed: ${err.message.slice(0, 100)}. Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ============================================================
// Output parsing — extract structured fields from LLM response
// ============================================================
function parseSummary(text) {
  // Quick SKIP detection
  if (/^\s*TOPIC:\s*SKIP/im.test(text)) {
    return { skip: true };
  }

  const fields = {};
  // Helper: extract a single-line field
  const extractField = (name) => {
    const re = new RegExp(`^${name}:\\s*(.+?)$`, 'mi');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  fields.topic = extractField('TOPIC');
  fields.product_family = extractField('PRODUCT_FAMILY');
  fields.question = extractField('QUESTION');
  fields.resolution = extractField('RESOLUTION');
  fields.tags = extractField('TAGS');

  // KEY_FACTS is a multiline block of bullets
  const keyFactsMatch = text.match(/KEY_FACTS:\s*\n((?:\s*-.+\n?)+)/i);
  if (keyFactsMatch) {
    fields.key_facts = keyFactsMatch[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-'))
      .map((line) => line.replace(/^-\s*/, '').trim())
      .filter((line) => line.length > 0);
  } else {
    fields.key_facts = [];
  }

  return { skip: false, fields, raw: text };
}

// ============================================================
// Read input
// ============================================================
async function loadCleanedTickets() {
  const stream = fs.createReadStream(INPUT, 'utf-8');
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const tickets = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      tickets.push(JSON.parse(line));
    } catch (err) {
      console.error(`⚠️  Could not parse line: ${line.slice(0, 80)}`);
    }
  }
  return tickets;
}

async function loadAlreadyDoneIds() {
  // Resume: read existing output file, collect ticket_ids that are already summarized.
  if (!fs.existsSync(OUTPUT)) return new Set();
  const stream = fs.createReadStream(OUTPUT, 'utf-8');
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const done = new Set();
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.ticket_id) done.add(String(obj.ticket_id));
    } catch {}
  }
  return done;
}

// ============================================================
// Concurrency-limited iteration
// ============================================================
async function runWithConcurrency(items, worker, concurrency) {
  const queue = [...items];
  let completed = 0;
  let totalSkipped = 0;
  let totalErrored = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  const startTime = Date.now();
  let lastReport = startTime;

  async function workerLoop() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const result = await worker(item);
        if (result.skipped) totalSkipped += 1;
        if (result.usage) {
          totalTokensIn += result.usage.prompt_tokens || 0;
          totalTokensOut += result.usage.completion_tokens || 0;
        }
      } catch (err) {
        totalErrored += 1;
        console.error(`❌ ticket ${item.ticket_id}: ${err.message.slice(0, 150)}`);
      }
      completed += 1;

      // Progress report every 5 seconds
      const now = Date.now();
      if (now - lastReport > 5000) {
        const elapsed = (now - startTime) / 1000;
        const rate = completed / elapsed;
        const eta = queue.length / Math.max(rate, 0.01);
        const costSoFar =
          (totalTokensIn / 1_000_000) * 0.15 + (totalTokensOut / 1_000_000) * 0.6;
        console.log(
          `  [${completed}/${completed + queue.length}] ${rate.toFixed(1)}/s ` +
          `eta=${Math.round(eta)}s skipped=${totalSkipped} err=${totalErrored} ` +
          `cost=$${costSoFar.toFixed(3)}`
        );
        lastReport = now;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => workerLoop());
  await Promise.all(workers);

  return { completed, totalSkipped, totalErrored, totalTokensIn, totalTokensOut };
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log(`📄 Input:  ${INPUT}`);
  console.log(`📝 Output: ${OUTPUT}`);
  console.log(`🤖 Model:  ${MODEL}`);
  console.log(`⚙️  Concurrency: ${CONCURRENCY}`);
  if (LIMIT > 0) console.log(`🔢 Limit:  ${LIMIT} tickets (pre-flight mode)`);
  console.log('');

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not set in environment');
    process.exit(1);
  }

  if (!fs.existsSync(INPUT)) {
    console.error(`❌ Input file not found: ${INPUT}`);
    console.error('   Run cleanTicketsJson.js first.');
    process.exit(1);
  }

  // Load cleaned tickets
  const allTickets = await loadCleanedTickets();
  console.log(`✅ Loaded ${allTickets.length} cleaned tickets`);

  // Resume support: skip already-summarized
  const doneIds = await loadAlreadyDoneIds();
  if (doneIds.size > 0) {
    console.log(`🔄 Resuming: ${doneIds.size} tickets already summarized, will skip them.`);
  }

  let todo = allTickets.filter((t) => !doneIds.has(String(t.ticket_id)));
  console.log(`📋 ${todo.length} tickets to summarize`);

  if (LIMIT > 0 && LIMIT < todo.length) {
    todo = todo.slice(0, LIMIT);
    console.log(`🎯 Limited to first ${LIMIT} for pre-flight`);
  }

  if (todo.length === 0) {
    console.log('✅ Nothing to do.');
    return;
  }

  // Open output file in append mode
  const outStream = fs.createWriteStream(OUTPUT, { flags: 'a' });

  async function worker(ticket) {
    let summaryResult;
    try {
      summaryResult = await summarizeWithRetry(ticket);
    } catch (err) {
      // Final failure after retries — write a marker so we don't retry forever on next run
      const marker = {
        ticket_id: ticket.ticket_id,
        error: err.message.slice(0, 300),
        attempted_at: new Date().toISOString(),
      };
      outStream.write(JSON.stringify(marker) + '\n');
      throw err;
    }

    const parsed = parseSummary(summaryResult.text);
    const output = {
      ticket_id: ticket.ticket_id,
      code: ticket.code,
      subject: ticket.subject,
      department_id: ticket.department_id,
      department_name: ticket.department_name,
      channel: ticket.channel,
      created_at: ticket.created_at,
      reply_cnt: ticket.reply_cnt,
      order_id: ticket.order_id,
      skipped: parsed.skip || false,
      summary: parsed.skip ? null : parsed.fields,
      summarized_at: new Date().toISOString(),
    };
    outStream.write(JSON.stringify(output) + '\n');
    return { skipped: parsed.skip, usage: summaryResult.usage };
  }

  const startTime = Date.now();
  const stats = await runWithConcurrency(todo, worker, CONCURRENCY);
  outStream.end();

  const elapsed = (Date.now() - startTime) / 1000;
  const costIn = (stats.totalTokensIn / 1_000_000) * 0.15;
  const costOut = (stats.totalTokensOut / 1_000_000) * 0.6;
  const totalCost = costIn + costOut;

  console.log('');
  console.log(`✅ Done in ${Math.round(elapsed)}s`);
  console.log(`   Completed:  ${stats.completed}`);
  console.log(`   Skipped:    ${stats.totalSkipped} (low-value, dropped)`);
  console.log(`   Errored:    ${stats.totalErrored}`);
  console.log(`   Input tokens:  ${stats.totalTokensIn.toLocaleString()}  ($${costIn.toFixed(3)})`);
  console.log(`   Output tokens: ${stats.totalTokensOut.toLocaleString()}  ($${costOut.toFixed(3)})`);
  console.log(`   Total cost: $${totalCost.toFixed(3)}`);
  console.log('');
  console.log(`📝 Wrote: ${OUTPUT}`);
  console.log('');

  if (LIMIT > 0) {
    console.log('🔍 Pre-flight complete. Inspect the output before running the full ingestion:');
    console.log(`     head -1 ${OUTPUT} | python3 -m json.tool`);
    console.log(`     wc -l ${OUTPUT}`);
    console.log('   Then re-run without --limit to process the rest (resumable).');
  } else {
    console.log('Next: node server/scripts/ingestTickets.js');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Fatal:', err);
    process.exit(1);
  });
}

module.exports = { main, parseSummary };
