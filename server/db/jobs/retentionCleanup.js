#!/usr/bin/env node
/**
 * Daily retention cleanup.
 *
 * Deletes:
 *   1. Conversations older than PII_RETENTION_DAYS (default: 730 = 2 years)
 *      → cascades to their messages + retrievals (FK ON DELETE CASCADE)
 *   2. PII identifier rows that are no longer referenced by any conversation
 *      (orphan cleanup)
 *
 * Intended to run from cron at 04:00 Oslo time daily.
 *
 * USAGE:
 *   node server/db/jobs/retentionCleanup.js
 *
 * Output is suitable for piping to a log file.
 *
 * UPDATE: now auto-loads server/.env so cron jobs (which don't inherit a
 * shell env) can find DATABASE_URL.
 */

const path = require('path');
// Load env vars from server/.env. This file lives at server/db/jobs/, so
// .env is TWO directories up.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { query, close } = require('../index');

const RETENTION_DAYS = parseInt(process.env.PII_RETENTION_DAYS || '730', 10);

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[retention] started ${startedAt} — retention window: ${RETENTION_DAYS} days`);

  // ---- Step 1: delete old conversations (cascades to messages + retrievals)
  const convResult = await query(
    `DELETE FROM conversations
       WHERE started_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
     RETURNING id`
  );
  const conversationsDeleted = convResult?.rows?.length || 0;

  // ---- Step 2: clean up orphan PII identifiers
  // A PII row is "orphan" if no conversation references its hash anymore.
  const piiResult = await query(
    `DELETE FROM pii_identifiers p
       WHERE p.last_seen < NOW() - INTERVAL '${RETENTION_DAYS} days'
         AND NOT EXISTS (
           SELECT 1 FROM conversations c
             WHERE c.user_email_hash = p.identifier_hash
                OR c.user_order_hash = p.identifier_hash
         )
     RETURNING id`
  );
  const piiDeleted = piiResult?.rows?.length || 0;

  const finishedAt = new Date().toISOString();
  console.log(`[retention] finished ${finishedAt}`);
  console.log(`[retention]   conversations deleted: ${conversationsDeleted}`);
  console.log(`[retention]   pii_identifiers deleted: ${piiDeleted}`);
}

if (require.main === module) {
  main()
    .then(() => close())
    .catch((err) => {
      console.error('[retention] unexpected error:', err);
      process.exit(1);
    });
}

module.exports = { main };
