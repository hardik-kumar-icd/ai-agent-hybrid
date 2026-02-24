/**
 * Script to ingest support tickets (Mirasvit) into Pinecone.
 * Usage:
 *   node server/scripts/ingestTickets.js [path-to-jsonl]
 *
 * Default path: project root/tickets_fixed.jsonl
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { embedAndStore } = require('../utils/embeddingService');

/**
 * Build a compact, searchable text representation for an admin reply
 * paired with the closest previous customer message (if any).
 */
function buildTicketChunkText(ticketId, conversation, adminIndex) {
  const adminMsg = conversation[adminIndex]?.message || '';

  // Find closest previous customer message in this ticket
  let customerMsg = '';
  for (let i = adminIndex - 1; i >= 0; i--) {
    if (conversation[i] && conversation[i].sender === 'customer') {
      customerMsg = conversation[i].message || '';
      break;
    }
  }

  // Fallback: if no preceding customer message, use the first customer message in the ticket
  if (!customerMsg) {
    const firstCustomer = conversation.find(m => m && m.sender === 'customer');
    if (firstCustomer && firstCustomer.message) {
      customerMsg = firstCustomer.message;
    }
  }

  const parts = [];
  parts.push(`Ticket ID: ${ticketId}`);
  if (customerMsg) {
    parts.push(`Customer question or context: ${customerMsg}`);
  }
  parts.push(`Agent reply: ${adminMsg}`);

  return parts.join('. ');
}

async function ingestTickets() {
  try {
    const defaultPath = path.join(__dirname, '../../tickets_fixed.jsonl');
    const ticketsPath = process.argv[2] || defaultPath;

    if (!fs.existsSync(ticketsPath)) {
      console.error(`❌ Error: tickets file not found at: ${ticketsPath}`);
      process.exit(1);
    }

    console.log(`📄 Reading tickets from: ${ticketsPath}`);

    const docs = [];
    const fileStream = fs.createReadStream(ticketsPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let record;
      try {
        record = JSON.parse(trimmed);
      } catch (err) {
        console.warn('⚠️ Skipping invalid JSON line in tickets file:', err.message);
        continue;
      }

      const ticketId = record.ticket_id || record.id || 'unknown';
      const conversation = Array.isArray(record.conversation) ? record.conversation : [];
      if (!conversation.length) continue;

      conversation.forEach((entry, idx) => {
        if (!entry || entry.sender !== 'admin' || !entry.message) return;

        const text = buildTicketChunkText(ticketId, conversation, idx);
        if (!text || !text.trim()) return;

        docs.push({
          pageContent: text,
          metadata: {
            source: 'tickets_fixed.jsonl',
            ticket_id: String(ticketId),
            role: 'admin',
          },
        });
      });
    }

    if (!docs.length) {
      console.error('❌ Error: No admin replies found to ingest from tickets file');
      process.exit(1);
    }

    console.log(`✅ Prepared ${docs.length} ticket chunks for embedding`);

    const sourceName = 'tickets_fixed.jsonl';
    console.log(`\n🔮 Creating embeddings and storing ticket chunks in Pinecone...`);
    console.log(`📝 Source name: ${sourceName}`);

    await embedAndStore(docs, sourceName);

    console.log(`\n✅ Successfully ingested ${docs.length} ticket chunks into Pinecone!`);
    console.log(`\n🎉 Ticket-based support knowledge is now available for the agent.`);
  } catch (error) {
    console.error('❌ Error ingesting tickets:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  ingestTickets();
}

module.exports = { ingestTickets };

