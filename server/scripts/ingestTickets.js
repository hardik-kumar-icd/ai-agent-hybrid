/**
 * ingestTickets.js
 *
 * Reads tickets_summarized.jsonl and ingests one chunk per non-skipped ticket
 * to Pinecone under source 'visor_tickets'.
 *
 * Stable IDs: visor_tickets_tid_<ticket_id> — idempotent re-runs overwrite,
 * never append (lesson learned from PR #13).
 *
 * Usage:
 *   node server/scripts/ingestTickets.js [path-to-tickets_summarized.jsonl]
 *
 * Default: server/scripts/data/tickets_summarized.jsonl
 *
 * Cost: ~$0.62 in OpenAI embeddings for 15.9k summaries.
 * Time: ~10-15 minutes.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const fs = require('fs');
const readline = require('readline');
const { embedAndStore } = require('../utils/embeddingService');

const DEFAULT_INPUT = path.join(__dirname, 'data', 'tickets_summarized.jsonl');
const SOURCE_NAME = 'visor_tickets';

// ============================================================
// Build the chunk text for one summarized ticket
// ============================================================
function buildChunkText(t) {
  const s = t.summary;
  if (!s) return null;  // shouldn't happen — skipped rows filtered out earlier

  const lines = [];

  // Header
  lines.push(`TICKET CODE: ${t.code || t.ticket_id}`);
  lines.push(`DEPARTMENT: ${t.department_name}`);
  if (s.topic) lines.push(`TOPIC: ${s.topic}`);
  if (s.product_family) lines.push(`PRODUCT FAMILY: ${s.product_family}`);
  if (t.created_at) lines.push(`DATE: ${t.created_at.split(' ')[0]}`);
  lines.push('');

  // Question
  if (s.question) {
    lines.push('QUESTION:');
    lines.push(s.question);
    lines.push('');
  }

  // Resolution
  if (s.resolution) {
    lines.push('RESOLUTION:');
    lines.push(s.resolution);
    lines.push('');
  }

  // Key facts as bullets
  if (Array.isArray(s.key_facts) && s.key_facts.length > 0) {
    lines.push('KEY FACTS:');
    for (const fact of s.key_facts) {
      lines.push(`- ${fact}`);
    }
    lines.push('');
  }

  // Tags
  if (s.tags) {
    lines.push(`TAGS: ${s.tags}`);
  }

  return lines.join('\n').trim();
}

// ============================================================
// Build Pinecone metadata for one summarized ticket
// ============================================================
function buildMetadata(t) {
  const s = t.summary || {};
  const meta = {
    ticket_id: Number(t.ticket_id),
    code: String(t.code || ''),
    department_id: Number(t.department_id),
    department_name: String(t.department_name || ''),
    channel: String(t.channel || ''),
    created_at: String(t.created_at || ''),
    reply_cnt: Number(t.reply_cnt || 0),
  };
  if (t.order_id) meta.order_id = String(t.order_id);
  if (s.product_family) meta.product_family = String(s.product_family);
  if (s.topic) meta.topic = String(s.topic);
  if (s.tags) meta.tags = String(s.tags);
  // Strip nulls (Pinecone metadata doesn't accept null)
  for (const k of Object.keys(meta)) {
    if (meta[k] === null || meta[k] === undefined || meta[k] === '') delete meta[k];
  }
  return meta;
}

// ============================================================
// Read JSONL input (resilient against malformed lines)
// ============================================================
async function loadSummarizedTickets(inputPath) {
  const stream = fs.createReadStream(inputPath, 'utf-8');
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const items = [];
  let line_no = 0;
  let malformed = 0;
  for await (const line of rl) {
    line_no += 1;
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      items.push(obj);
    } catch {
      malformed += 1;
    }
  }
  if (malformed > 0) console.warn(`⚠️  Skipped ${malformed} malformed JSONL lines`);
  return items;
}

// ============================================================
// Main
// ============================================================
async function main() {
  const inputPath = process.argv[2] || DEFAULT_INPUT;
  console.log(`📄 Reading summarized tickets: ${inputPath}`);

  if (!fs.existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputPath}`);
    console.error(`   Run summarizeTickets.js first.`);
    process.exit(1);
  }

  const all = await loadSummarizedTickets(inputPath);
  console.log(`✅ Loaded ${all.length} summarized records`);

  // Filter out skipped tickets and error markers
  const valid = all.filter((t) => {
    if (t.error) return false;        // error marker from summarizer
    if (t.skipped) return false;      // LLM said SKIP (low general value)
    if (!t.summary) return false;     // shouldn't happen but defensive
    if (!t.summary.question && !t.summary.resolution) return false;  // empty parse
    return true;
  });

  console.log(`✅ ${valid.length} valid tickets to ingest (after filtering skips + errors)`);
  const skippedCount = all.length - valid.length;
  console.log(`⏭️  ${skippedCount} skipped or errored, not ingested`);

  if (valid.length === 0) {
    console.error('❌ Nothing to ingest. Aborting.');
    process.exit(1);
  }

  // Build LangChain-style Document objects with STABLE IDs.
  // This is the PR #13 lesson: deterministic chunk IDs → re-runs are idempotent.
  const docs = [];
  let buildErrors = 0;
  for (const t of valid) {
    const text = buildChunkText(t);
    if (!text || text.length < 30) {
      buildErrors += 1;
      continue;
    }
    docs.push({
      id: `visor_tickets_tid_${t.ticket_id}`,
      pageContent: text,
      metadata: buildMetadata(t),
    });
  }

  if (buildErrors > 0) {
    console.warn(`⚠️  ${buildErrors} tickets produced unusable chunks, skipped`);
  }
  console.log(`✅ Built ${docs.length} chunks`);

  // Sample inspection — show first 2
  console.log('');
  console.log('--- Sample chunks (first 2) ---');
  for (let i = 0; i < Math.min(2, docs.length); i++) {
    const d = docs[i];
    console.log(`[${i + 1}] id=${d.id}  meta.product_family=${d.metadata.product_family || '?'}  meta.topic=${(d.metadata.topic || '?').slice(0, 50)}`);
    console.log(`    text (first 200 chars):`);
    console.log(`    ${d.pageContent.slice(0, 200).replace(/\n/g, '\n    ')}`);
    console.log('');
  }

  console.log(`🔮 Embedding and storing in Pinecone (source: ${SOURCE_NAME})...`);
  await embedAndStore(docs, SOURCE_NAME);

  console.log('');
  console.log(`✅ Ingested ${docs.length} ticket chunks under source '${SOURCE_NAME}'`);
  console.log('');
  console.log('🎉 Tickets are now available for the agent (search_tickets tool).');
  console.log('');
  console.log('Verify with:');
  console.log(`   curl "http://localhost:5000/api/pinecone/test-search?q=plisse+sideskinner&topK=5" \\`);
  console.log(`     -H "Authorization: Bearer $ADMIN_API_KEY"`);
  console.log('');
  console.log('When confident, run the legacy cleanup:');
  console.log('   node server/scripts/cleanupLegacyTickets.js --dry-run');
  console.log('   node server/scripts/cleanupLegacyTickets.js --force');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
}

module.exports = { main, buildChunkText, buildMetadata };
