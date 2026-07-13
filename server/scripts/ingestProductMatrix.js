/**
 * ingestProductMatrix.js
 *
 * Ingests the Visor product matrix chunks (from Visor_Produktmatrise.xlsx and
 * Visor_Tekstil_og_Opphengsmatrise.xlsx) into Pinecone under source name
 * 'visor_products', alongside existing Magento product data.
 *
 * Chunks use stable IDs based on product name so re-running this script
 * safely upserts (overwrites) existing entries without duplication.
 *
 * Usage:
 *   node server/scripts/ingestProductMatrix.js [path-to-json]
 *
 * Default path: server/scripts/data/visor_product_matrix_chunks.json
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const fs = require('fs');
const { embedAndStore } = require('../utils/embeddingService');

const DEFAULT_INPUT = path.join(__dirname, 'data', 'visor_product_matrix_chunks.json');
const SOURCE_NAME = 'visor_products';

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[æå]/g, 'a')
    .replace(/ø/g, 'o')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

async function ingestProductMatrix() {
  const inputPath = process.argv[2] || DEFAULT_INPUT;

  if (!fs.existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`📄 Reading: ${inputPath}`);
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  console.log(`✅ Loaded ${raw.length} chunks`);

  // Convert to the format embedAndStore expects: [{pageContent, metadata}]
  // Add stable chunk_id based on product name so upserts overwrite cleanly.
  const docs = raw.map((chunk) => {
    const slug = slugify(chunk.metadata.product_name || chunk.pageContent.slice(0, 60));
    return {
      pageContent: chunk.pageContent,
      metadata: {
        ...chunk.metadata,
        chunk_id: `product_matrix_${slug}`,
      },
    };
  });

  console.log(`\n🔮 Embedding and storing ${docs.length} chunks into Pinecone source: ${SOURCE_NAME}`);
  await embedAndStore(docs, SOURCE_NAME);
  console.log(`\n✅ Successfully ingested ${docs.length} product matrix chunks into ${SOURCE_NAME}!`);
  console.log(`\n💡 Product matrix data is now available alongside existing Magento product data.`);
}

ingestProductMatrix().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
