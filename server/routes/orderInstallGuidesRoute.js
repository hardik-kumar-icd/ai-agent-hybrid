const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const platformConfig = require('../config/platform');
const { logOrderLookup } = require('../utils/securityLogger');

const router = express.Router();

// Bounds worst-case hang if Magento is slow or unresponsive.
const CMS_REQUEST_TIMEOUT_MS = 10000;

function loadInstallVideoMapping() {
  const mappingPath = path.join(__dirname, '..', 'data', 'installVideos.json');
  if (!fs.existsSync(mappingPath)) {
    return {
      general: null,
      byCategoryId: {},
      byCategoryKey: {},
    };
  }
  try {
    const raw = fs.readFileSync(mappingPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      general: parsed.general || null,
      byCategoryId: parsed.byCategoryId || {},
      byCategoryKey: parsed.byCategoryKey || {},
    };
  } catch {
    return { general: null, byCategoryId: {}, byCategoryKey: {} };
  }
}

/**
 * Normalize for matching admin CSV keys (e.g. plissegardiner) to Magento category names.
 * Folds common Norwegian letters so storefront names still match.
 */
function normalizeCategoryKey(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a');
  s = s.replace(/\s+/g, '_').replace(/[^a-z0-9_:-]/g, '');
  return s;
}

function pickVideoForCategories(categoryIds, categoryNames, mapping) {
  const ids = Array.isArray(categoryIds) ? categoryIds : [];
  for (const id of ids) {
    const key = String(id);
    const entry = mapping.byCategoryId?.[key];
    if (entry?.url) return { ...entry, matchedBy: 'category_id', matchedValue: key };
  }

  const names = Array.isArray(categoryNames) ? categoryNames : [];
  const keys = Object.keys(mapping.byCategoryKey || {});

  for (const n of names) {
    const nk = normalizeCategoryKey(n);
    if (!nk) continue;
    const entry = mapping.byCategoryKey?.[nk];
    if (entry?.url) return { ...entry, matchedBy: 'category_name', matchedValue: nk };
  }

  // Fuzzy: Magento may return "Plissegardiner — Standard" or store-specific labels.
  for (const n of names) {
    const nk = normalizeCategoryKey(n);
    if (nk.length < 4) continue;
    for (const mapKey of keys) {
      if (mapKey.length < 4) continue;
      if (nk.includes(mapKey) || mapKey.includes(nk)) {
        const entry = mapping.byCategoryKey?.[mapKey];
        if (entry?.url) {
          return {
            ...entry,
            matchedBy: 'category_name_fuzzy',
            matchedValue: `${mapKey} (from "${n}")`,
          };
        }
      }
    }
  }

  return mapping.general?.url ? { ...mapping.general, matchedBy: 'general', matchedValue: 'general' } : null;
}

/**
 * When Catalog API is denied (401), we cannot read product categories.
 * Best-effort: match order line name + SKU against mapping keys (substring).
 * Also adds light hints so "plisse" in title/SKU can map to plissegardiner.
 */
function pickVideoFromOrderLineFallback(item, mapping) {
  const raw = `${item.name || ''} ${item.sku || ''}`;
  let blob = normalizeCategoryKey(raw);
  if (/plisse|pliss|plissegardiner/i.test(raw)) blob += '_plissegardiner';
  if (/rullegardin|rullegardiner|roller/i.test(raw)) blob += '_rullegardiner';

  const keys = Object.keys(mapping.byCategoryKey || {}).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (k.length < 4) continue;
    if (blob.includes(k)) {
      const entry = mapping.byCategoryKey[k];
      if (entry?.url) {
        return { ...entry, matchedBy: 'order_line_text', matchedValue: k };
      }
    }
  }
  return null;
}

function productStepsHadCatalog401(steps) {
  return Array.isArray(steps) && steps.some((s) => String(s.error || '').includes('401'));
}

async function fetchMagentoOrderWithItems({ order_id, email }) {
  const { endpoints, auth } = platformConfig;
  const headers = {
    Authorization: `Bearer ${auth.magento.bearerToken}`,
    'Content-Type': 'application/json',
  };

  // Magento 2: customers see increment_id. Search by increment_id first.
  const searchUrl =
    `${endpoints.magento}/orders?` +
    `searchCriteria[filter_groups][0][filters][0][field]=increment_id&` +
    `searchCriteria[filter_groups][0][filters][0][value]=${encodeURIComponent(String(order_id).trim())}&` +
    `searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;

  const searchResponse = await axios.get(searchUrl, { headers, timeout: CMS_REQUEST_TIMEOUT_MS });
  const items = searchResponse.data?.items || [];
  const order = items[0] || null;
  if (!order) return null;

  if (String(order.customer_email || '').toLowerCase() !== String(email || '').toLowerCase()) {
    return { order: null, emailMismatch: true };
  }

  const lineItems = (order.items || [])
    .map((it) => ({
      product_id: it.product_id,
      sku: it.sku,
      name: it.name,
      qty: it.qty_ordered,
    }))
    .filter((it) => it.sku || it.product_id);

  return { order, items: lineItems };
}

function extractCategoryIdsFromProductPayload(data) {
  if (!data) return [];
  const links = data.extension_attributes?.category_links;
  if (Array.isArray(links) && links.length) {
    return links.map((c) => Number(c.category_id)).filter((n) => Number.isFinite(n));
  }
  const raw = data.category_ids;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((c) => Number(c)).filter((n) => Number.isFinite(n));
  }
  return [];
}

function extractUrlKeyFromProductPayload(data) {
  if (!data) return null;
  const attrs = data.custom_attributes;
  if (!Array.isArray(attrs)) return null;
  const entry = attrs.find((a) => a.attribute_code === 'url_key');
  return entry?.value || null;
}

function buildProductUrl(urlKey) {
  if (!urlKey) return null;
  const base = (process.env.MAGENTO_API_URL || '').replace(/\/rest\/V1\/?$/, '');
  return `${base}/${urlKey}`;
}

async function fetchMagentoCategoryName(categoryId, headers) {
  const { endpoints } = platformConfig;
  const url = `${endpoints.magento}/categories/${encodeURIComponent(String(categoryId).trim())}`;
  const resp = await axios.get(url, { headers, timeout: CMS_REQUEST_TIMEOUT_MS });
  return resp.data?.name || null;
}

function axiosErrSummary(err) {
  if (!err?.response) return err?.message || String(err);
  return `${err.response.status} ${err.response.statusText || ''}`.trim();
}

/**
 * Resolve category IDs for a line item with step-by-step debug (for Postman / logs).
 */
async function resolveProductCategoriesDebug({ productId, sku, headers }) {
  const { endpoints, auth } = platformConfig;
  const h = headers || {
    Authorization: `Bearer ${auth.magento.bearerToken}`,
    'Content-Type': 'application/json',
  };

  const steps = [];

  if (sku) {
    const url = `${endpoints.magento}/products/${encodeURIComponent(String(sku).trim())}`;
    try {
      const resp = await axios.get(url, { headers: h, timeout: CMS_REQUEST_TIMEOUT_MS });
      const ids = extractCategoryIdsFromProductPayload(resp.data).filter((n) => Number.isFinite(n));
      const urlKey = extractUrlKeyFromProductPayload(resp.data);
      steps.push({
        step: 'GET /products/{sku}',
        sku: String(sku).trim(),
        ok: true,
        status: resp.status,
        category_ids: ids,
      });
      if (ids.length) return { categoryIds: ids, urlKey, steps };
    } catch (err) {
      steps.push({
        step: 'GET /products/{sku}',
        sku: String(sku).trim(),
        ok: false,
        error: axiosErrSummary(err),
      });
    }
  }

  if (productId) {
    const url =
      `${endpoints.magento}/products?` +
      `searchCriteria[filter_groups][0][filters][0][field]=entity_id&` +
      `searchCriteria[filter_groups][0][filters][0][value]=${encodeURIComponent(String(productId).trim())}&` +
      `searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;
    try {
      const resp = await axios.get(url, { headers: h, timeout: CMS_REQUEST_TIMEOUT_MS });
      const product = resp.data?.items?.[0];
      const ids = extractCategoryIdsFromProductPayload(product).filter((n) => Number.isFinite(n));
      const urlKey = extractUrlKeyFromProductPayload(product);
      steps.push({
        step: 'GET /products?searchCriteria[entity_id]',
        product_id: productId,
        ok: true,
        status: resp.status,
        category_ids: ids,
        found_product: Boolean(product),
      });
      if (ids.length) return { categoryIds: ids, urlKey, steps };
    } catch (err) {
      steps.push({
        step: 'GET /products?searchCriteria[entity_id]',
        product_id: productId,
        ok: false,
        error: axiosErrSummary(err),
      });
    }
  }

  return { categoryIds: [], urlKey: null, steps };
}

router.post('/install-guides', async (req, res) => {
  try {
    const { order_id, email } = req.body || {};
    if (!order_id || !email) {
      return res.status(400).json({ message: 'order_id and email are required' });
    }

    logOrderLookup(order_id, email, '[installVideos]');

    const mapping = loadInstallVideoMapping();
    const mappingLoaded = Boolean(mapping.general?.url) ||
      (mapping.byCategoryId && Object.keys(mapping.byCategoryId).length > 0) ||
      (mapping.byCategoryKey && Object.keys(mapping.byCategoryKey).length > 0);
    if (!mappingLoaded) {
      return res.status(400).json({
        message: 'No install video mapping is configured yet. Upload install_videos.txt or install_videos.csv in the admin ingest page.',
      });
    }

    const { platform } = platformConfig;
    if (platform !== 'magento' && platform !== 'wordpress') {
      return res.status(500).json({ message: `Unsupported platform: ${platform}` });
    }

    if (platform === 'wordpress') {
      return res.status(501).json({ message: 'Install videos for WordPress is not wired yet.' });
    }

    const orderResult = await fetchMagentoOrderWithItems({ order_id, email });
    if (!orderResult) {
      return res.status(404).json({ message: 'Order not found' });
    }
    if (orderResult.emailMismatch) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const outVideos = [];
    const { endpoints, auth } = platformConfig;
    const headers = {
      Authorization: `Bearer ${auth.magento.bearerToken}`,
      'Content-Type': 'application/json',
    };
    const categoryNameCache = new Map();
    let catalogApi401 = false;
    const debug = {
      mapping: {
        hasGeneral: Boolean(mapping.general?.url),
        byCategoryIdCount: Object.keys(mapping.byCategoryId || {}).length,
        byCategoryKeyCount: Object.keys(mapping.byCategoryKey || {}).length,
        sampleCategoryKeys: Object.keys(mapping.byCategoryKey || {}).slice(0, 20),
      },
      magento_catalog_api: null,
      items: [],
    };

    for (const item of orderResult.items || []) {
      const { categoryIds, urlKey, steps: productSteps } = await resolveProductCategoriesDebug({
        productId: item.product_id,
        sku: item.sku,
        headers,
      });
      const productUrl = buildProductUrl(urlKey);
      if (productStepsHadCatalog401(productSteps)) catalogApi401 = true;

      const categoryDetails = [];
      const categoryNames = [];
      for (const cid of categoryIds) {
        const k = String(cid);
        let name = null;
        let nameError = null;
        if (categoryNameCache.has(k)) {
          name = categoryNameCache.get(k);
        } else {
          try {
            name = await fetchMagentoCategoryName(cid, headers);
            categoryNameCache.set(k, name);
          } catch (err) {
            nameError = axiosErrSummary(err);
            categoryNameCache.set(k, null);
          }
        }
        if (name) categoryNames.push(name);
        categoryDetails.push({
          category_id: cid,
          name: name || null,
          normalized: name ? normalizeCategoryKey(name) : null,
          fetch_error: nameError,
        });
      }

      let picked = pickVideoForCategories(categoryIds, categoryNames, mapping);
      if (!picked?.url && mapping.general?.url) {
        picked = { ...mapping.general, matchedBy: 'general', matchedValue: 'general' };
      }

      let orderLineFallback = null;
      if (productStepsHadCatalog401(productSteps) && picked?.matchedBy === 'general') {
        orderLineFallback = pickVideoFromOrderLineFallback(item, mapping);
        if (orderLineFallback?.url) picked = orderLineFallback;
      }

      debug.items.push({
        sku: item.sku || null,
        product_id: item.product_id || null,
        category_ids: categoryIds,
        category_names: categoryNames,
        normalized_category_names: categoryNames.map((n) => normalizeCategoryKey(n)),
        mapping_keys_tried: Object.keys(mapping.byCategoryKey || {}),
        product_steps: productSteps,
        category_steps: categoryDetails,
        order_line_text_fallback: orderLineFallback
          ? { matched: true, by: orderLineFallback.matchedBy, value: orderLineFallback.matchedValue }
          : { matched: false },
        picked: picked?.url
          ? { by: picked.matchedBy || 'unknown', value: picked.matchedValue || null, url: picked.url }
          : null,
      });
      if (picked?.url) {
        outVideos.push({
          title: picked.title || picked.label || (picked.matchedBy === 'general' ? 'General installation video' : 'Installation video'),
          url: picked.url,
          product: {
            sku: item.sku || null,
            name: item.name || null,
            product_id: item.product_id || null,
            product_url: productUrl,
          },
          matched: {
            by: picked.matchedBy || 'unknown',
            value: picked.matchedValue || null,
            category_ids: categoryIds || [],
            category_names: categoryNames || [],
          },
        });
      }
    }

    // De-dupe by URL (keep first occurrence)
    const seen = new Set();
    const deduped = outVideos.filter((v) => {
      const u = v.url;
      if (!u) return false;
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });

    // If nothing matched, return general if available
    if (deduped.length === 0 && mapping.general?.url) {
      deduped.push({
        title: mapping.general.title || mapping.general.label || 'General installation video',
        url: mapping.general.url,
        product: null,
        matched: { by: 'general', value: 'general', category_ids: [] },
      });
    }

    if (catalogApi401) {
      debug.magento_catalog_api = {
        issue: '401 Unauthorized on Magento catalog REST (GET /V1/products or related).',
        effect:
          'The integration token can read orders but not catalog products, so category_ids stay empty and matching falls back to general (or order-line text if keywords match).',
        fix:
          'Magento Admin → System → Integrations → [your integration] → API → Resource Access: enable Magento Catalog → Products and Categories (read). Save, then update MAGENTO_BEARER_TOKEN in server/.env if the integration issues a new token.',
      };
    }

    const includeDebug = req.query.debug === '1' || (req.body && req.body.debug === true);
    return res.json({
      order_id: String(order_id).trim(),
      videos: deduped,
      ...(includeDebug ? { debug } : {}),
    });
  } catch (error) {
    console.error('[installVideos] Error:', error);
    return res.status(500).json({ message: 'Failed to fetch installation videos' });
  }
});

module.exports = router;

