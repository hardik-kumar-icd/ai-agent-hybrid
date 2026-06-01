/**
 * cleanupLegacyTickets.js
 *
 * One-off cleanup script: removes the legacy 'tickets_fixed.jsonl' vectors
 * from Pinecone after the fresh 'visor_tickets' source has been ingested.
 *
 * Operates ONLY on chunks with metadata.source === 'tickets_fixed.jsonl'.
 * FAQ, products, and the new visor_tickets sources are untouched.
 *
 * Pattern mirrors cleanupProductDuplicates.js from PR #13.
 *
 * Usage:
 *   node server/scripts/cleanupLegacyTickets.js [--dry-run] [--force]
 *
 * Flags:
 *   --dry-run    List what would be deleted, but don't delete anything
 *   --force      Skip the confirmation prompt and proceed
 *
 * Safety:
 *   - Filters strictly by metadata.source === 'tickets_fixed.jsonl'
 *   - Other sources never touched
 *   - Uses Pinecone's deleteMany (not deleteAll)
 *   - Re-runnable: if no chunks remain, exits cleanly
 *   - Recommended: run AFTER ingestTickets.js so retrieval doesn't gap
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { initializePinecone } = require('../utils/embeddingService');

const LEGACY_SOURCE = 'tickets_fixed.jsonl';
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const PINECONE_DIM = 3072;  // text-embedding-3-large dimension
const TOP_K = 10000;        // large enough to enumerate all legacy chunks
const DELETE_BATCH_SIZE = 100;

async function listLegacyVectors(index) {
  console.log(`[1/3] Listing all ${LEGACY_SOURCE} vectors (dummy-query topK=${TOP_K})...`);
  const dummyVector = new Array(PINECONE_DIM).fill(0);
  const response = await index.query({
    vector: dummyVector,
    topK: TOP_K,
    includeMetadata: true,
    filter: { source: { $eq: LEGACY_SOURCE } },
  });

  const matches = response.matches || [];
  console.log(`     Found ${matches.length} ${LEGACY_SOURCE} vectors.`);
  return matches;
}

async function main() {
  console.log('');
  console.log('=== Legacy ticket source cleanup ===');
  console.log(`Source to delete: ${LEGACY_SOURCE}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}`);
  console.log('');

  const index = await initializePinecone();
  const matches = await listLegacyVectors(index);

  if (matches.length === 0) {
    console.log('No legacy ticket vectors found. Pinecone is already clean.');
    return;
  }

  // Sample inspection
  console.log('');
  console.log('Sample of legacy vectors (first 5):');
  for (const m of matches.slice(0, 5)) {
    const text = (m.metadata && m.metadata.text) || '';
    console.log(`  id=${m.id}`);
    console.log(`     ${text.slice(0, 100).replace(/\n/g, ' ')}`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log(`[2/3] Plan: would delete ${matches.length} vectors with source='${LEGACY_SOURCE}'.`);
    console.log('');
    console.log(`DRY RUN — no deletions performed. Re-run without --dry-run to apply.`);
    return;
  }

  if (!FORCE) {
    console.log(`[2/3] Plan: delete ${matches.length} vectors with source='${LEGACY_SOURCE}'.`);
    console.log('');
    console.log('To proceed, re-run with --force flag.');
    console.log('  node server/scripts/cleanupLegacyTickets.js --force');
    return;
  }

  // Execute deletes in batches
  const idsToDelete = matches.map((m) => m.id);
  console.log(`[3/3] Deleting ${idsToDelete.length} vectors in batches of ${DELETE_BATCH_SIZE}...`);
  let deleted = 0;
  for (let i = 0; i < idsToDelete.length; i += DELETE_BATCH_SIZE) {
    const batch = idsToDelete.slice(i, i + DELETE_BATCH_SIZE);
    console.log(`  batch ${Math.floor(i / DELETE_BATCH_SIZE) + 1}/${Math.ceil(idsToDelete.length / DELETE_BATCH_SIZE)} (${batch.length} ids)`);
    await index.deleteMany(batch);
    deleted += batch.length;
    if (i + DELETE_BATCH_SIZE < idsToDelete.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log('');
  console.log(`✅ Deleted ${deleted} legacy ticket vectors.`);
  console.log('');
  console.log('Pinecone now contains only:');
  console.log('  - visor_faqs');
  console.log('  - visor_products');
  console.log('  - visor_tickets (fresh)');
  console.log('');
  console.log('The agent will now read all ticket retrievals from visor_tickets.');
  console.log('The legacy fallback path in utils/ticketSearch.js will never trigger.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
}

module.exports = { main };
