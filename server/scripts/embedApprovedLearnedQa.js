#!/usr/bin/env node
/**
 * embedApprovedLearnedQa.js
 *
 * Embeds approved-but-unembedded learned_qa candidates into the Pinecone
 * 'learned_qa' source (Drop 2, Phase C2).
 *
 * USAGE:
 *   node server/scripts/embedApprovedLearnedQa.js
 *
 * Reads learned_qa rows where status='approved' AND embedding_id IS NULL,
 * embeds each one's question (text-embedding-3-large, 3072-dim) into
 * source='learned_qa' with the answer carried in metadata, then marks the row
 * embedded. Safe to run repeatedly — only unembedded approved rows are touched.
 * Intended for manual runs now; can be moved to cron later (like
 * retentionCleanup.js).
 *
 * Auto-loads server/.env so OPENAI_API_KEY / PINECONE_* are available without a
 * manual export — matches the pattern used by migrate.js and the ingest scripts.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { close } = require('../db/index');
const episodicMemory = require('../services/episodicMemoryService');

async function main() {
  console.log('[embed-learned-qa] starting...');
  const result = await episodicMemory.embedApprovedCandidates({ limit: 200 });
  console.log(
    `[embed-learned-qa] done. processed=${result.processed} ` +
    `embedded=${result.embedded} failed=${result.failed}`
  );
}

if (require.main === module) {
  main()
    .then(() => close())
    .catch((err) => {
      console.error('[embed-learned-qa] unexpected error:', err);
      process.exit(1);
    });
}

module.exports = { main };
