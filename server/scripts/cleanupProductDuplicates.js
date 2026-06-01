/**
 * cleanupProductDuplicates.js
 *
 * One-off cleanup script for the visor_products source in Pinecone.
 *
 * Background: Before PR #13, ingestProducts.js used timestamp-based vector IDs.
 * Re-running the script with a fresh timestamp inserted new vectors instead of
 * overwriting existing ones, leaving 2× (or more) copies of every product.
 *
 * This script does ONE thing:
 *   - Lists all `visor_products` vectors in Pinecone (via paginated query
 *     with a dummy zero vector + metadata filter)
 *   - Identifies duplicates by `product_id` metadata
 *   - Deletes all but the most recent vector ID per product_id
 *
 * After running this, re-running ingestProducts.js (with the PR #13 patch)
 * is idempotent: re-runs overwrite, never append.
 *
 * Usage:
 *   node server/scripts/cleanupProductDuplicates.js [--dry-run]
 *
 * Flags:
 *   --dry-run    List what would be deleted, but don't delete anything
 *   --force      Skip the confirmation prompt and proceed
 *
 * Safety:
 *   - Operates ONLY on chunks with metadata.source === 'visor_products'
 *   - FAQ and ticket sources are untouched
 *   - Uses Pinecone's deleteMany (not deleteAll)
 *   - Re-runnable: if there are no duplicates, it just exits cleanly
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { initializePinecone } = require('../utils/embeddingService');

const SOURCE_NAME = 'visor_products';
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

async function listAllProductVectors(index) {
  // Pinecone doesn't have a "list all" API for vectors. We query with a dummy
  // zero vector and a high topK, then paginate using ID-based deduplication.
  // For our scale (~100 vectors) this is fine; we just want to enumerate.
  const dummyVector = new Array(3072).fill(0);
  const TOP_K = 1000; // well above 56 × 2 = 112 expected vectors

  console.log(`[1/3] Listing all ${SOURCE_NAME} vectors via dummy-query topK=${TOP_K}...`);
  const response = await index.query({
    vector: dummyVector,
    topK: TOP_K,
    includeMetadata: true,
    filter: { source: { $eq: SOURCE_NAME } },
  });

  const matches = response.matches || [];
  console.log(`     Found ${matches.length} ${SOURCE_NAME} vectors total.`);
  return matches;
}

function groupByProductId(matches) {
  const groups = new Map();
  let missingProductId = 0;
  for (const m of matches) {
    const pid = m.metadata?.product_id;
    if (pid == null) {
      missingProductId += 1;
      continue;
    }
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(m);
  }
  return { groups, missingProductId };
}

function pickKeepAndDelete(group) {
  // Prefer the canonical PR #13 ID format (visor_products_pid_<n>) if any
  // exists in the group — that's the new stable ID.
  const canonical = group.find((v) => v.id === `visor_products_pid_${v.metadata.product_id}`);
  if (canonical) {
    const toDelete = group.filter((v) => v.id !== canonical.id).map((v) => v.id);
    return { keep: canonical.id, delete: toDelete, reason: 'canonical_id_exists' };
  }

  // Otherwise prefer the highest upload_timestamp (most recent ingestion).
  const sorted = [...group].sort(
    (a, b) => (b.metadata?.upload_timestamp || 0) - (a.metadata?.upload_timestamp || 0)
  );
  const keep = sorted[0];
  const toDelete = sorted.slice(1).map((v) => v.id);
  return { keep: keep.id, delete: toDelete, reason: 'most_recent_kept' };
}

async function main() {
  console.log('');
  console.log('=== visor_products duplicate cleanup ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}`);
  console.log('');

  const index = await initializePinecone();

  // [1/3] List vectors
  const matches = await listAllProductVectors(index);

  if (matches.length === 0) {
    console.log('No visor_products vectors found. Nothing to do.');
    return;
  }

  // [2/3] Group by product_id
  console.log(`[2/3] Grouping by product_id...`);
  const { groups, missingProductId } = groupByProductId(matches);
  console.log(`     Unique products: ${groups.size}`);
  console.log(`     Vectors missing product_id metadata: ${missingProductId}`);

  // Identify duplicate groups
  const duplicateGroups = Array.from(groups.entries()).filter(([_, vs]) => vs.length > 1);
  console.log(`     Products with duplicates: ${duplicateGroups.length}`);
  console.log(``);

  if (duplicateGroups.length === 0) {
    console.log('No duplicates found. Pinecone is clean.');
    return;
  }

  // Determine what to delete
  const toDelete = [];
  const decisions = [];
  for (const [pid, group] of duplicateGroups) {
    const decision = pickKeepAndDelete(group);
    decision.product_id = pid;
    decision.group_size = group.length;
    decisions.push(decision);
    toDelete.push(...decision.delete);
  }

  console.log(`[3/3] Plan: delete ${toDelete.length} duplicate vectors across ${duplicateGroups.length} products`);
  console.log('');
  console.log('Sample decisions (first 10):');
  for (const d of decisions.slice(0, 10)) {
    console.log(`  pid=${d.product_id} group_size=${d.group_size}  KEEP=${d.keep}  reason=${d.reason}`);
    for (const did of d.delete) {
      console.log(`                                                   DELETE=${did}`);
    }
  }
  console.log('');

  if (DRY_RUN) {
    console.log(`DRY RUN — no deletions performed. Re-run without --dry-run to apply.`);
    return;
  }

  if (!FORCE) {
    console.log(`To proceed with deletion, re-run with --force flag.`);
    console.log(`  node server/scripts/cleanupProductDuplicates.js --force`);
    return;
  }

  // Execute deletes in batches (Pinecone deleteMany takes a list of IDs)
  const BATCH = 100;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const batch = toDelete.slice(i, i + BATCH);
    console.log(`Deleting batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(toDelete.length / BATCH)} (${batch.length} IDs)...`);
    await index.deleteMany(batch);
    deleted += batch.length;
    if (i + BATCH < toDelete.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log('');
  console.log(`✅ Deleted ${deleted} duplicate vectors.`);
  console.log(`   Pinecone now has 1 vector per product (${groups.size} products).`);
  console.log('');
  console.log(`Next step: re-run ingestProducts.js to refresh chunks with the new stable IDs.`);
  console.log(`           Subsequent runs will be idempotent — no more duplicates.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
}

module.exports = { main };
