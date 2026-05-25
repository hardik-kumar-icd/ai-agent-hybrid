/**
 * One-shot FAQ scraper for https://test.visor.no/faq
 *
 * Purpose: visor_faqs.json was never migrated from Render. This script
 * scrapes the live FAQ page (Magento 2 + Hyva theme + Alpine.js tabs) and
 * generates the JSON file that ingestFAQs.js expects.
 *
 * The FAQ page is server-rendered HTML; Alpine.js only controls visibility
 * (x-show), so cheerio can extract everything from a single HTTP GET.
 *
 * Structure being scraped:
 *   - 6 tabs identified by <button @click="activeTab = 'TabName'">
 *   - Each tab is a <div x-show="activeTab === 'TabName'">
 *   - Inside: <ul class="space-y-2"> with <li x-data="{ open: false }"> items
 *   - Question: inside <button><span>QUESTION TEXT</span>...</button>
 *   - Answer: inside <div x-show="open" x-collapse class="prose ...">ANSWER HTML</div>
 *
 * Usage:
 *   cd /var/www/visor-agent
 *   node server/scripts/scrapeFaqs.js
 *
 * Output: visor_faqs.json in project root (one level up from server/)
 *
 * After running, ingest with:
 *   node server/scripts/ingestFAQs.js
 */

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');

const FAQ_URL = 'https://test.visor.no/faq';
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'visor_faqs.json');

// Tab name -> human-readable category label (matches what's shown in UI)
const TAB_LABELS = {
  General: 'General',
  Plissegardiner: 'Plissegardiner',
  Rullegardiner: 'Rullegardiner',
  Lamellgardiner: 'Lamellgardiner',
  PersiennerLUX: 'Persienner LUX',
  Liftgardiner: 'Liftgardiner',
};

/**
 * Convert answer HTML to plain text while preserving paragraph breaks
 * and link URLs. Keeps the answer readable when embedded for retrieval.
 */
function htmlToCleanText($, answerDiv) {
  // Clone so we don't mutate the live DOM
  const $clone = cheerio.load(`<div>${$(answerDiv).html() || ''}</div>`);

  // Inline link URLs: "click here" -> "click here (https://...)"
  $clone('a[href]').each((_, el) => {
    const $a = $clone(el);
    const href = $a.attr('href');
    const text = $a.text().trim();
    if (href && text && !text.includes(href)) {
      $a.replaceWith(`${text} (${href})`);
    }
  });

  // Convert <br> to newlines
  $clone('br').replaceWith('\n');

  // Block-level elements get newline separators
  $clone('p, li, h1, h2, h3, h4, h5, h6, div, tr').each((_, el) => {
    const $el = $clone(el);
    $el.append('\n');
  });

  // Remove images entirely (the agent can't show them; alt text often unhelpful)
  $clone('img').remove();

  // Collapse to text, then normalize whitespace
  let text = $clone.root().text();
  text = text
    .replace(/\u00a0/g, ' ') // non-breaking space -> regular space
    .replace(/[ \t]+/g, ' ') // collapse horizontal whitespace
    .replace(/ *\n */g, '\n') // trim around newlines
    .replace(/\n{3,}/g, '\n\n') // max 2 consecutive newlines
    .trim();

  return text;
}

/**
 * Extract every Q&A pair under a single tab's <div x-show="activeTab === 'X'">
 */
function extractTabFaqs($, tabName) {
  const faqs = [];

  // Find the tab container. Alpine attribute selector — escape the quotes.
  // The DOM literally contains: x-show="activeTab === 'General'"
  const selector = `div[x-show="activeTab === '${tabName}'"]`;
  const $tabDiv = $(selector);

  if ($tabDiv.length === 0) {
    console.warn(`  [warn] Tab container not found for: ${tabName}`);
    return faqs;
  }

  // Each Q&A is a <li x-data="{ open: false }">
  const $items = $tabDiv.find('li[x-data]').filter((_, el) => {
    const xData = $(el).attr('x-data') || '';
    return xData.includes('open');
  });

  $items.each((_, li) => {
    const $li = $(li);

    // Question text is in the first <button> > <span>
    const question = $li.find('button > span').first().text().trim();

    // Answer is in the <div x-show="open" ...>
    const $answerDiv = $li.find('div[x-show="open"]').first();
    const answer = htmlToCleanText($, $answerDiv);

    if (question && answer) {
      faqs.push({
        question,
        answer,
        category: TAB_LABELS[tabName] || tabName,
      });
    } else {
      console.warn(
        `  [warn] Skipped Q&A (missing question or answer) in ${tabName}: "${question.slice(0, 60)}"`,
      );
    }
  });

  return faqs;
}

async function main() {
  console.log(`Fetching ${FAQ_URL} ...`);

  const res = await fetch(FAQ_URL, {
    headers: {
      // Some Magento installs gate on a real-looking UA
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${FAQ_URL}`);
  }

  const html = await res.text();
  console.log(`Fetched ${html.length.toLocaleString()} bytes`);

  const $ = cheerio.load(html);

  // Sanity check: confirm we're on the FAQ page
  const tabButtons = $('button[\\@click^="activeTab"]');
  console.log(`Found ${tabButtons.length} tab buttons in DOM`);

  const allFaqs = [];
  for (const tabName of Object.keys(TAB_LABELS)) {
    const tabFaqs = extractTabFaqs($, tabName);
    console.log(`  ${tabName.padEnd(18)} -> ${tabFaqs.length} Q&As`);
    allFaqs.push(...tabFaqs);
  }

  if (allFaqs.length === 0) {
    throw new Error(
      'No FAQs extracted. Page structure may have changed. Check selectors.',
    );
  }

  // Write JSON
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allFaqs, null, 2), 'utf8');
  console.log(`\nWrote ${allFaqs.length} FAQs to ${OUTPUT_PATH}`);
  console.log('\nNext step:');
  console.log('  node server/scripts/ingestFAQs.js');
}

main().catch((err) => {
  console.error('\nScraper failed:', err);
  process.exit(1);
});
