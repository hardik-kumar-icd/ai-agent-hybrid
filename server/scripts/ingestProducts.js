/**
 * ingestProducts.js
 *
 * Reads server/scripts/data/products_cleaned.json (produced by
 * cleanProductsJson.js) and ingests one chunk per product into Pinecone
 * under source name 'visor_products'.
 *
 * Usage:
 *   node server/scripts/ingestProducts.js [path-to-products_cleaned.json]
 *
 * Default path: server/scripts/data/products_cleaned.json
 *
 * Chunk format adapts to product type:
 *   - Real blinds:                 includes DIMENSIONS section (BREDDE + HØYDE)
 *   - Rails / curtain hardware:    no DIMENSIONS section
 *   - Accessories (remotes, etc):  no DIMENSIONS section
 *   - All products:                always have PRICE and ABOUT sections
 *
 * Pinecone metadata stored per chunk:
 *   source, sku, product_id, product_name, category_name, family_root,
 *   url, min/max_width, min/max_length, price_min/max, delivery_days,
 *   is_motorized, is_slope_model, is_accessory
 *   (plus the standard source/chunk_id/text/upload_timestamp from embedAndStore)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const fs = require('fs');
const { embedAndStore } = require('../utils/embeddingService');

const DEFAULT_INPUT = path.join(__dirname, 'data', 'products_cleaned.json');
const SOURCE_NAME = 'visor_products';

// ---------------------------------------------------------------------------
// Build the chunk text for one product
// ---------------------------------------------------------------------------
function buildChunkText(p) {
  const lines = [];

  lines.push(`PRODUCT: ${p.name}`);
  lines.push(`SKU: ${p.sku}`);
  lines.push(`CATEGORY: ${p.category_name}`);
  if (p.url_key) {
    const base = (process.env.MAGENTO_STORE_BASE_URL || 'https://test.visor.no').replace(/\/$/, '');
    lines.push(`URL: ${base}/${p.url_key}`);
  }
  lines.push('');

  // DIMENSIONS — only emit lines for data that exists
  const hasWidth = p.min_width != null && p.max_width != null;
  const hasLength = p.min_length != null && p.max_length != null;
  if (hasWidth || hasLength) {
    lines.push('DIMENSIONS:');
    if (hasWidth) {
      lines.push(`  Bredde: ${p.min_width}–${p.max_width} cm`);
    }
    if (hasLength) {
      lines.push(`  Høyde: ${p.min_length}–${p.max_length} cm`);
    }
    lines.push('');
  }

  // PRICE — always present
  if (p.price_label) {
    lines.push(`PRICE: ${p.price_label}` + (p.price_min != null && p.price_max != null && p.price_min !== p.price_max
      ? ` (${p.price_min}–${p.price_max} NOK)`
      : ''));
  } else if (p.price_min != null && p.price_max != null) {
    lines.push(`PRICE: ${p.price_min}–${p.price_max} NOK`);
  }

  // DELIVERY
  if (p.delivery_days != null) {
    lines.push(`DELIVERY: ${p.delivery_days} dager`);
  }

  // FLAGS — only emit for products where motorization is a real attribute.
  // Real blinds have dimensions, rails / accessories do not.
  const isBlind = (p.min_width != null && p.max_width != null) || p.is_motorized === true;
  if (isBlind) {
    lines.push(`MOTORISERT: ${p.is_motorized ? 'Ja' : 'Nei'}`);
    if (p.is_slope_model) {
      lines.push(`SKRÅVINDU-EGNET: Ja`);
    }
  }

  lines.push('');

  // ABOUT — cleaned description, soft-cap at 2000 chars at sentence boundary
  const aboutText = p.description || p.short_description || '';
  if (aboutText && aboutText.length > 0) {
    lines.push('ABOUT:');
    lines.push(softCap(aboutText, 2000));
  }

  if (p.assembly_advise_note) {
    lines.push('');
    lines.push(`ASSEMBLY NOTE: ${p.assembly_advise_note}`);
  }

  return lines.join('\n');
}

function softCap(text, max) {
  if (text.length <= max) return text;
  // Try to cut at the last sentence boundary before max
  const slice = text.slice(0, max);
  const lastPunctuation = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? ')
  );
  if (lastPunctuation > max * 0.6) {
    return slice.slice(0, lastPunctuation + 1) + '…';
  }
  return slice.replace(/\s+\S*$/, '') + '…';
}

// ---------------------------------------------------------------------------
// Build the Pinecone metadata for one product
// ---------------------------------------------------------------------------
function buildMetadata(p) {
  const baseUrl = (process.env.MAGENTO_STORE_BASE_URL || 'https://test.visor.no').replace(/\/$/, '');
  const meta = {
    sku: String(p.sku || ''),
    product_id: Number(p.id),
    product_name: String(p.name || ''),
    category_name: String(p.category_name || ''),
    url: p.url_key ? `${baseUrl}/${p.url_key}` : null,
    is_motorized: Boolean(p.is_motorized),
    is_slope_model: Boolean(p.is_slope_model),
    is_accessory: Boolean(p.is_accessory),
  };
  // Numeric fields — only include when present (Pinecone metadata filters can use these)
  if (p.min_width != null) meta.min_width = Number(p.min_width);
  if (p.max_width != null) meta.max_width = Number(p.max_width);
  if (p.min_length != null) meta.min_length = Number(p.min_length);
  if (p.max_length != null) meta.max_length = Number(p.max_length);
  if (p.price_min != null) meta.price_min = Number(p.price_min);
  if (p.price_max != null) meta.price_max = Number(p.price_max);
  if (p.delivery_days != null) meta.delivery_days = Number(p.delivery_days);
  if (p.family_root != null) meta.family_root = Number(p.family_root);
  // Strip null fields (Pinecone metadata doesn't accept null values)
  for (const k of Object.keys(meta)) {
    if (meta[k] === null || meta[k] === undefined) delete meta[k];
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const inputPath = process.argv[2] || DEFAULT_INPUT;
  console.log(`📄 Reading cleaned products: ${inputPath}`);

  if (!fs.existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputPath}`);
    console.error(`   Run cleanProductsJson.js first to generate it.`);
    process.exit(1);
  }

  const products = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  if (!Array.isArray(products) || products.length === 0) {
    console.error(`❌ Cleaned products file is empty or not an array`);
    process.exit(1);
  }

  console.log(`✅ Loaded ${products.length} cleaned products`);

  // Build LangChain-style Document objects with STABLE IDs.
  // Using product_id (numeric, always unique per product in Magento) as the
  // identity, so re-running this script is idempotent — same products get the
  // same vector IDs, Pinecone upserts (overwrites) rather than appending.
  // Previous bug: timestamp-based IDs caused 2x duplicate vectors on re-ingest.
  const docs = products.map((p) => ({
    id: `visor_products_pid_${p.id}`,
    pageContent: buildChunkText(p),
    metadata: buildMetadata(p),
  }));

  // Spot-check the first 2 chunks
  console.log('');
  console.log('--- Sample chunks (first 2) ---');
  for (let i = 0; i < Math.min(2, docs.length); i++) {
    const d = docs[i];
    console.log(`[${i + 1}] sku=${d.metadata.sku} category=${d.metadata.category_name}`);
    console.log(`    text length: ${d.pageContent.length} chars`);
    console.log(`    first 200 chars:`);
    console.log(`    ${d.pageContent.slice(0, 200).replace(/\n/g, '\n    ')}`);
    console.log('');
  }

  console.log(`🔮 Creating embeddings and storing in Pinecone (source: ${SOURCE_NAME})...`);
  await embedAndStore(docs, SOURCE_NAME);

  console.log(`\n✅ Successfully ingested ${docs.length} product chunks into Pinecone!`);
  console.log(`📝 Source name: ${SOURCE_NAME}`);
  console.log(`\n🎉 Products are now available for the agent (search_products tool).`);
  console.log(`\n💡 Test with: curl admin /api/pinecone/test-search?q=max+bredde+plisse`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
}

module.exports = { main, buildChunkText, buildMetadata };
