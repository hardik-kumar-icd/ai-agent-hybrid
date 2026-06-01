/**
 * cleanProductsJson.js
 *
 * Reads the raw Magento product export, normalizes each product for
 * ingestion, and writes two outputs:
 *   - products_cleaned.json         (input for ingestProducts.js)
 *   - products_gaps_report.json     (which products are missing what)
 *
 * Usage:
 *   node server/scripts/cleanProductsJson.js <input.json> [<categories.json>]
 *
 * Defaults:
 *   input.json      = server/scripts/data/live_products.json
 *   categories.json = server/scripts/data/live_category.json
 *
 * Outputs are written next to the input file.
 *
 * Category classification rules (see DROP2_FINAL_DESIGN.md and conversation
 * with @parth on 2026-06-01):
 *
 *   1. cat 171 (Montering, Rabatt)   -> SKIP (service items, not products)
 *   2. cat 136 (Motionblinds) + name "Plisse..."   -> "Plissegardiner med batterimotorer"
 *      cat 136 + name "Rullegardin/Absolutt/Kassett" -> "Rullegardiner med batterimotorer"
 *      cat 136 only                                  -> "Motionblinds"
 *   3. cat 172                                       -> "Motionblinds tilbehor"
 *   4. Family categories (via parent-chain traversal):
 *        descendant of cat 8  -> "Plissegardin"
 *        descendant of cat 3  -> "Rullegardin"
 *        descendant of cat 14 -> "Lamellgardin"
 *        descendant of cat 19 -> "Persienne"
 *        descendant of cat 25 -> "Liftgardin"
 *   5. cat 141 catch-all  -> "Gardiner / Oppheng"
 *   6. fallback           -> "Diverse"  (logged as a gap)
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const DEFAULT_PRODUCTS = path.join(SCRIPT_DIR, 'data', 'live_products.json');
const DEFAULT_CATEGORIES = path.join(SCRIPT_DIR, 'data', 'live_category.json');

const SERVICE_CATEGORY_ID = 171;       // skip
const MOTIONBLINDS_CATEGORY_ID = 136;  // motorized
const MOTIONBLINDS_ACCESSORY_ID = 172; // accessories
const GARDINER_CATEGORY_ID = 141;      // catch-all curtains/rails

const FAMILY_ROOTS = {
  3: 'Rullegardin',
  8: 'Plissegardin',
  14: 'Lamellgardin',
  19: 'Persienne',
  25: 'Liftgardin',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stripHtml(s) {
  if (!s || typeof s !== 'string') return '';
  let out = s.replace(/<[^>]+>/g, ' ');
  out = out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#?[a-z0-9]+;/gi, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

function attrsOf(product) {
  const result = {};
  for (const a of (product.custom_attributes || [])) {
    result[a.attribute_code] = a.value;
  }
  return result;
}

function categoryIdsOf(product) {
  const links = product.extension_attributes && product.extension_attributes.category_links;
  if (Array.isArray(links)) {
    return links.map((l) => Number(l.category_id)).filter((n) => Number.isFinite(n));
  }
  return [];
}

function nameMatchesPlisse(name) {
  return /plisse/i.test(name || '');
}

function nameMatchesRullegardin(name) {
  const n = name || '';
  return /rullegardin|absolutt|absolute|kassett/i.test(n);
}

// ---------------------------------------------------------------------------
// Category tree -> parent chain helpers
// ---------------------------------------------------------------------------
function flattenCategoryTree(node, parentMap, nameMap) {
  parentMap.set(node.id, node.parent_id || null);
  nameMap.set(node.id, node.name || `category_${node.id}`);
  for (const child of (node.children_data || [])) {
    flattenCategoryTree(child, parentMap, nameMap);
  }
}

function buildParentChain(catId, parentMap, maxDepth = 10) {
  const chain = [];
  let current = catId;
  for (let i = 0; i < maxDepth; i++) {
    if (current == null) break;
    chain.push(current);
    current = parentMap.get(current);
  }
  return chain;
}

function ancestorsInclude(catId, ancestorId, parentMap) {
  const chain = buildParentChain(catId, parentMap);
  return chain.includes(ancestorId);
}

// ---------------------------------------------------------------------------
// Primary classification
// ---------------------------------------------------------------------------
function classifyProduct(product, parentMap) {
  const catIds = categoryIdsOf(product);
  const catSet = new Set(catIds);
  const name = product.name || '';

  // 1. Skip service items
  if (catSet.has(SERVICE_CATEGORY_ID)) {
    return { skip: true, reason: 'service_item' };
  }

  // 2. Motionblinds motorized variants (composite labels)
  if (catSet.has(MOTIONBLINDS_CATEGORY_ID)) {
    if (nameMatchesPlisse(name)) {
      return { category_name: 'Plissegardiner med batterimotorer', is_motorized: true };
    }
    if (nameMatchesRullegardin(name)) {
      return { category_name: 'Rullegardiner med batterimotorer', is_motorized: true };
    }
    return { category_name: 'Motionblinds', is_motorized: true };
  }

  // 3. Motionblinds accessories (remotes, bridges, cables)
  if (catSet.has(MOTIONBLINDS_ACCESSORY_ID)) {
    return { category_name: 'Motionblinds tilbehør', is_accessory: true };
  }

  // 4. Family categories via parent-chain traversal
  for (const cid of catIds) {
    for (const [familyRoot, familyName] of Object.entries(FAMILY_ROOTS)) {
      const rootId = Number(familyRoot);
      if (cid === rootId || ancestorsInclude(cid, rootId, parentMap)) {
        return { category_name: familyName, family_root: rootId };
      }
    }
  }

  // 5. Catch-all curtains/rails
  if (catSet.has(GARDINER_CATEGORY_ID)) {
    return { category_name: 'Gardiner / Oppheng' };
  }

  // 6. Fallback
  return { category_name: 'Diverse', fallback: true };
}

// ---------------------------------------------------------------------------
// Cleaning a single product
// ---------------------------------------------------------------------------
function cleanProduct(product, parentMap, nameMap) {
  const a = attrsOf(product);
  const catIds = categoryIdsOf(product);

  const classification = classifyProduct(product, parentMap);
  if (classification.skip) {
    return { skipped: true, reason: classification.reason, id: product.id, sku: product.sku };
  }

  const hasWidth = a.min_width != null && a.max_width != null;
  const hasLength = a.min_length != null && a.max_length != null;
  const description = stripHtml(a.description || '');
  const shortDescription = stripHtml(a.short_description || '');

  // For products without a long description, fall back to short_description
  const aboutText = description.length >= 50 ? description : shortDescription;

  const cleaned = {
    id: product.id,
    sku: product.sku,
    name: (product.name || '').trim(),
    url_key: a.url_key || null,
    category_name: classification.category_name,
    family_root: classification.family_root || null,
    is_motorized: a.motionblinds_product === '1' || a.motionblinds_product === 1 || classification.is_motorized === true,
    is_slope_model: a.slope_modell === '1' || a.slope_modell === 1,
    is_accessory: classification.is_accessory === true,
    all_category_ids: catIds,
    all_category_names: catIds.map((cid) => nameMap.get(cid) || `category_${cid}`).filter(Boolean),
    // Dimensions (may be absent — chunk format adapts)
    min_width: hasWidth ? Number(a.min_width) : null,
    max_width: hasWidth ? Number(a.max_width) : null,
    min_length: hasLength ? Number(a.min_length) : null,
    max_length: hasLength ? Number(a.max_length) : null,
    // Price
    price_min: a.product_price_min != null ? Number(a.product_price_min) : null,
    price_max: a.product_price_max != null ? Number(a.product_price_max) : null,
    price_label: stripHtml(a.price_label || ''),
    // Delivery
    delivery_days: a.delivery_days != null ? Number(a.delivery_days) : null,
    // Text content
    description: aboutText,
    short_description: shortDescription,
    assembly_advise_note: stripHtml(a.assembly_advise_note || '') || null,
    // Visibility/status (informational, not used in chunk but kept for filtering)
    status: product.status,
    visibility: product.visibility,
  };

  return { cleaned };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const productsPath = process.argv[2] || DEFAULT_PRODUCTS;
  const categoriesPath = process.argv[3] || DEFAULT_CATEGORIES;

  console.log(`📄 Reading products: ${productsPath}`);
  console.log(`📄 Reading categories: ${categoriesPath}`);

  if (!fs.existsSync(productsPath)) {
    console.error(`❌ Products file not found: ${productsPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(categoriesPath)) {
    console.error(`❌ Categories file not found: ${categoriesPath}`);
    process.exit(1);
  }

  const productsRaw = JSON.parse(fs.readFileSync(productsPath, 'utf-8'));
  const categoriesRaw = JSON.parse(fs.readFileSync(categoriesPath, 'utf-8'));

  // Build parent-chain + name lookup maps
  const parentMap = new Map();
  const nameMap = new Map();
  flattenCategoryTree(categoriesRaw, parentMap, nameMap);
  console.log(`✅ Loaded category tree: ${parentMap.size} categories`);

  // Products may be {items: [...]} or a bare array — handle both
  const products = Array.isArray(productsRaw) ? productsRaw : (productsRaw.items || []);
  console.log(`✅ Loaded ${products.length} products`);

  const cleaned = [];
  const skipped = [];
  const gaps = []; // products with missing/notable data

  for (const p of products) {
    const result = cleanProduct(p, parentMap, nameMap);

    if (result.skipped) {
      skipped.push(result);
      continue;
    }

    const c = result.cleaned;
    cleaned.push(c);

    // Note gaps
    const productGaps = [];
    if (c.category_name === 'Diverse') productGaps.push('no_category_family_match');
    if (!c.min_width && !c.is_accessory && c.category_name !== 'Gardiner / Oppheng') {
      productGaps.push('no_dimensions');
    }
    if (!c.description || c.description.length < 50) productGaps.push('short_or_missing_description');
    if (!c.url_key) productGaps.push('no_url_key');
    if (!c.delivery_days) productGaps.push('no_delivery_days');
    if (productGaps.length > 0) {
      gaps.push({ id: c.id, sku: c.sku, name: c.name, category_name: c.category_name, gaps: productGaps });
    }
  }

  // Write outputs
  const outputDir = path.dirname(productsPath);
  const cleanedPath = path.join(outputDir, 'products_cleaned.json');
  const gapsPath = path.join(outputDir, 'products_gaps_report.json');

  fs.writeFileSync(cleanedPath, JSON.stringify(cleaned, null, 2));
  fs.writeFileSync(gapsPath, JSON.stringify({ skipped, gaps, generated_at: new Date().toISOString() }, null, 2));

  // Summary
  console.log(``);
  console.log(`✅ Cleaned ${cleaned.length} products`);
  console.log(`⏭️  Skipped ${skipped.length} service items`);
  console.log(`⚠️  ${gaps.length} products have notable gaps (see ${gapsPath})`);
  console.log(``);
  console.log(`Category distribution:`);
  const counts = {};
  for (const c of cleaned) {
    counts[c.category_name] = (counts[c.category_name] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(50)} ${count}`);
  }
  console.log(``);
  console.log(`📝 Wrote: ${cleanedPath}`);
  console.log(`📝 Wrote: ${gapsPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
}

module.exports = { main, cleanProduct, classifyProduct };
