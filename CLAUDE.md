# CLAUDE.md — Project Session Tracker
> **Rule:** Read this file at the start of every session. Update sections 4, 5, 6, 7 before pushing. Commit this file with every push.
>
> Last updated: 2026-04-29 | Active branch: `feature/widget-installation-guides`

---

## 1. Project Overview

**Visor.no AI Agent** — an embeddable customer-support chat widget for a Norwegian blinds/window-treatment e-commerce store. Injected into a Magento 2 storefront via a single `<script>` tag.

The widget lets customers:
- Ask product/FAQ questions (answered via RAG knowledge base + GPT-4o)
- Check order status (email + order number form → Magento API)
- Watch installation videos (email + order number → API resolves product categories → returns matched Vimeo embeds)
- Get ordering/measuring guidance (redirects to a static CMS page)

The backend also ships a **React admin dashboard** at `/admin` for uploading knowledge-base files and managing Pinecone.

**Target store:** `https://test.visor.no` (Magento 2)
**Production backend:** `https://ai-agent-hybrid.onrender.com`
**GitHub repo:** `https://github.com/hardik-kumar-icd/ai-agent-hybrid`

---

## 2. Tech Stack

| Layer | Technology | Version / Notes |
|---|---|---|
| Backend | Node.js + Express | Express 5.2.1, CommonJS (`require`) |
| AI model | OpenAI GPT-4o | via LangChain `ChatOpenAI` |
| Query expansion | OpenAI GPT-4o-mini | Used to expand search queries before RAG |
| Embeddings | `text-embedding-3-large` | 3072 dimensions |
| AI orchestration | LangChain | `@langchain/openai` v1.2.2 |
| Vector DB | Pinecone (serverless, AWS, cosine) | `@pinecone-database/pinecone` v6.1.3 |
| Session store | In-memory (Node.js Map) | 24-hour TTL, no Redis, clears on restart |
| Widget frontend | React 18.2.0 + Vite 7.3.1 | Built as UMD bundle; React loaded from CDN |
| Admin dashboard | React + Vite (separate app) | `client/admin/` → built to `server/public/admin/` |
| File parsing | `pdf-parse`, custom JSON/CSV/TXT | `server/utils/fileParser.js` |
| Auth | Bearer token string comparison | `ADMIN_API_KEY` env var, no JWT signing |
| Rate limiting | `express-rate-limit` | 60 req/min global, 10 req/min on ingest |
| Tunneling (dev) | ngrok | Named tunnel `ai-agent` |
| Deployment | Render.com | Auto-deploy on push to branch |
| Target platform | Magento 2 | REST API integration token auth |

---

## 3. How the System Works (Architecture)

### 3a. Widget UI Flow (client/src/components/ChatWidget.jsx)

When widget opens, it shows a **welcome message** + **5 option buttons:**

| Button | What happens |
|---|---|
| FAQs | User types a question → calls `POST /visor-chat` → RAG answer |
| Product Info | User types product query → calls `POST /visor-chat` → RAG answer |
| Order Status | Shows email+orderID form → submits to `POST /visor-chat` with both fields |
| Installation guides | Shows same email+orderID form → submits to `POST /api/order/install-guides` |
| How do I order? | Shows hardcoded text + button that opens `https://test.visor.no/how-to-install/` in new tab |

After order status / install-guides submit, options reappear after 2 seconds (`showOptionsAgain` state).

**Language detection:** If user types a message containing English keywords (`what`, `how`, `order`, etc.) the UI switches placeholder text from Norwegian to English. The backend independently detects language via the system prompt.

**Order detection shortcut:** If user types a message containing order-related keywords (`order`, `ordre`, `ordrestatus`, etc.) the widget skips the API call and directly shows the order form.

**Persistence:**
- `conversationId` → saved to `localStorage` (survives page refresh)
- Last 10 messages → saved to `sessionStorage` (survives tab navigation, clears on tab close)

**Video embeds:** `videoEmbeds` field on assistant messages → rendered as `<iframe>` in `ChatMessage.jsx`. YouTube `watch?v=` URLs converted to `/embed/`, Vimeo `vimeo.com/{id}` converted to `player.vimeo.com/video/{id}`. Max 3 embeds shown.

### 3b. AI Agent Logic (server/agents/visorAgent.js)

The main agent (`processVisorMessage`) uses **GPT-4o with 3 tools:**

```
1. rag_search     → searches Pinecone knowledge base
2. get_order_details → cached local order lookup
3. get_order_status  → live Magento API call (fallback)
```

**RAG pipeline per query:**
1. `expandQueryForSearch()` — GPT-4o-mini generates alternative phrasings (80 tokens max)
2. `searchSimilar(expandedQuery, topK=24)` — fetches 24 candidates from Pinecone
3. `reRankByKeywordOverlap(docs, originalQuery)` — adds `0.06 * matchCount` keyword boost to semantic score, re-sorts
4. Takes top 10 results
5. Injects as context into GPT-4o

**Ticket fallback logic:**
- If KB has no substantive answer (`hasSubstantiveKbContext()` returns false) → try `answerFromTickets()`
- If KB has data BUT a ticket scores ≥ 0.65 OR user query is a substring of a ticket chunk → prefer tickets
- `hasSubstantiveKbContext()`: returns false if context is empty, starts with `NO_KNOWLEDGE_BASE_DATA`, or only contains "Fant ikke svar" + contact info without specific topic markers

**System prompt key rules (important for debugging):**
- ALWAYS call `rag_search` first for every question
- Language = CURRENT user message language (not history, not KB language)
- Order info: never share price/currency/billing address
- Product info from KB: price IS shareable (public catalog data)
- `NO_KNOWLEDGE_BASE_DATA` = don't invent, just say you don't know

### 3c. Install Guides API (server/routes/orderInstallGuidesRoute.js)

```
POST /api/order/install-guides
Body: { order_id, email }
```

Flow:
1. Load `server/data/installVideos.json` (written by admin ingest upload)
2. Verify mapping exists (400 if not)
3. Fetch Magento order by `increment_id` (customer-facing number), verify email match
4. For each line item: try `GET /products/{sku}` → category IDs → category names
5. Match category to video: ID exact → name exact → name fuzzy → order line text fallback → general
6. De-dupe videos by URL
7. Return `{ order_id, videos: [...], debug: {...} }`

**Known issue:** Magento Catalog API may return 401 if integration token lacks catalog read permission. When this happens, category_ids stay empty and matching falls back to SKU/name keyword matching (e.g. "plisse" in SKU → `plissegardiner`). Fix: add catalog read permissions to Magento integration.

---

## 4. Today's Session

**Date:** 2026-04-30

**What was done:**

### Afternoon (2026-04-30)
- Render server pe `product_url: null` issue fix kiya — `MAGENTO_BEARER_TOKEN` Render Dashboard mein update kiya (`rotg25kq42etlk4wsf7dnw6p5fz1ql4e`)
- `install_videos.txt` Render admin panel pe upload kiya — `installVideos.json` ban gayi
- **Permanent fix:** `server/data/*` → `!server/data/installVideos.json` gitignore exception diya — file ab git mein committed hai, har redeploy pe available rahegi
- `.gitignore` updated + `server/data/installVideos.json` committed + pushed
- Render auto-deploy hua — `product_url` working confirmed via curl ✅
- COMMIT_LOG.md updated

### Morning (2026-04-30)
- `product-tabs.phtml` — Added `openTabFromHash()` JS function:
  - Reads URL hash on `DOMContentLoaded`
  - Supports: `#howto`, `#additional`, `#description`, `#reviews`
  - Dispatches `product-tab:open` custom event (350ms delay for Alpine.js init)
  - Works for both desktop tabs + mobile accordion automatically
- **Widget layout redesigned** — product list now shows interleaved (name → SKU → button → next product):
  - `ChatWidget.jsx`: `assistantText` now only header ("Her er produktene i ordren din:"), no more product names in text
  - `ChatWidget.jsx`: `productLinks` items now include `sku` and `buttonLabel` (language-aware)
  - `ChatWidget.jsx`: hash changed from `#additional` → `#howto`
  - `ChatMessage.jsx`: each product renders as `<div>` with name + SKU + button (not flat list)
  - `ChatMessage.css`: added `.chat-message-product-item`, `.chat-message-product-item-name`, `.chat-message-product-item-sku`; removed truncation from button text
- **Button text**: `categoryLabel` → language-aware label:
  - Norwegian: `"Klikk for å se siden"`
  - English: `"Click to view page"`
- Widget bundle rebuilt 4x during session — latest: `client/dist/widget.bundle.umd.js` (39.87 kB)
- API tested via curl (order 37897, ankush@icecubedigital.com) — category matching confirmed ✅

**Files changed (uncommitted as of 2026-04-30):**
- `CLAUDE.md` — this file
- `SAMJHO.md` — new guide file
- `client/.env` — API URL changed to localhost:5000
- `START.md` — untracked
- `server/.env` — new Magento bearer token
- `server/routes/orderInstallGuidesRoute.js` — added `url_key` extraction, `buildProductUrl()`, `product_url` in response
- `client/src/components/ChatWidget.jsx` — full install guides response redesign: productLinks with sku + buttonLabel + #howto hash
- `client/src/components/ChatMessage.jsx` — interleaved layout: name → SKU → button per product
- `client/src/components/ChatMessage.css` — added product item styles, removed button text truncation
- `client/dist/widget.bundle.umd.js` — rebuilt (needs upload to Magento media)
- `product-tabs.phtml` (Magento theme file, not in this repo) — added hash-based tab detection JS

**Last code commit:**
```
a8d205c feat(widget): installation guides flow, video embeds, order install API
```

---

## 5. Completed Tasks

| When | What |
|---|---|
| Early dev | Express server, OpenAI chat, Pinecone setup |
| Early dev | RAG pipeline: file ingest (PDF/JSON/CSV/TXT) → chunking → embed → Pinecone |
| Early dev | Widget v1: React chat, UMD Vite build, `<script>` embed |
| Early dev | Admin dashboard (client/admin → served at /admin) |
| Early dev | Rate limiting, PII filtering, session mgmt, security logging |
| Early dev | Magento order lookup (increment_id, email verification) |
| Early dev | FAQ JSON ingestion + `ingestFAQs.js` script |
| Early dev | Mirasvit ticket ingestion (JSONL) + ticket RAG fallback |
| Early dev | LLM query expansion (gpt-4o-mini) for better RAG retrieval |
| Early dev | Hybrid re-ranking: semantic score + keyword overlap boost |
| Early dev | Widget UX: restart chat, download transcript, option buttons, order form |
| Earlier | Axios timeout raised to 2 min on admin ingest |
| Earlier | Admin file upload size configurable via `MAX_FILE_SIZE_MB` |
| Earlier | Admin token input normalised (trims whitespace) |
| 2026-04-29 | Installation guides API + widget button + Vimeo embeds (original) |
| 2026-04-29 | `START.md` process guide created (untracked) |
| 2026-04-29 | `CLAUDE.md` session tracker created (this file) |
| 2026-04-29 | `SAMJHO.md` Hinglish guide for non-developers created |
| 2026-04-29 | `client/.env` fixed — changed API URL to `http://localhost:5000` |
| 2026-04-29 | Magento integration token updated — new token with catalog read permissions |
| 2026-04-29 | `installVideos.json` + `install_videos.txt` set up (Plissegardiner + Rullegardiner + General) |
| 2026-04-29 | Install guides API tested via curl — category matching confirmed working ✅ |
| 2026-04-29 | **Full redesign**: video embeds → product page link buttons (`productUrl#additional`) |
| 2026-04-29 | `orderInstallGuidesRoute.js` — added `url_key` extraction + `buildProductUrl()` |
| 2026-04-29 | `ChatWidget.jsx` — install guides response produces `productLinks` (not videoEmbeds) |
| 2026-04-29 | `ChatMessage.jsx` — renders product name + link buttons from `productLinks` prop |
| 2026-04-29 | `ChatMessage.css` — added product link button styles |
| 2026-04-29 | Widget bundle rebuilt (`npm run build:widget`) — pending upload to Magento |
| 2026-04-30 | `product-tabs.phtml` — hash-based tab detection JS added (`openTabFromHash()`) |
| 2026-04-30 | Widget layout: interleaved product name → SKU → button (one per product) |
| 2026-04-30 | Button text: language-aware "Klikk for å se siden" / "Click to view page" |
| 2026-04-30 | Hash changed: `#additional` → `#howto` (opens "Hvordan ta mål og montere" tab) |
| 2026-04-30 | Install guides API curl tested — category matching confirmed ✅ |
| 2026-04-30 | Widget bundle rebuilt — `client/dist/widget.bundle.umd.js` ready (pending Magento upload) |
| 2026-04-30 | Render env: `MAGENTO_BEARER_TOKEN` updated → `product_url` fix ✅ |
| 2026-04-30 | `installVideos.json` committed to git — no more re-upload needed after redeploy ✅ |
| 2026-04-30 | `.gitignore`: `server/data/` → `server/data/*` + `!server/data/installVideos.json` |

---

## 6. Pending / In Progress

- [ ] **Upload widget bundle to Magento** — `client/dist/widget.bundle.umd.js` → Magento Admin → Content → Media → `tekmetric/js/widget.bundle.js`
- [ ] **Upload `product-tabs.phtml` to Magento theme** — file edited at `/tmp/fz3temp-2/product-tabs.phtml` — upload to Magento theme → replaces current file
- [ ] **Test end-to-end on test.visor.no** — widget → Monteringsveiledninger → order + email → product buttons → click → howto tab opens + scrolls
- [ ] **New option button in widget** — content/action TBD. Files: `ChatWidget.jsx`
- [ ] **WordPress install guides** — route returns `501 Not Implemented`
- ✅ ~~**Commit all changes**~~ — pushed to `feature/widget-installation-guides`
- ✅ ~~**Update Render env vars**~~ — `MAGENTO_BEARER_TOKEN` updated in Render Dashboard

---

## 7. Next Steps (pick up from here)

1. **Upload widget bundle** — Magento Admin → Content → Media → `tekmetric/js/` → delete old `widget.bundle.js` → upload `client/dist/widget.bundle.umd.js` → rename to `widget.bundle.js`
2. **Upload `product-tabs.phtml`** — Upload edited file to Magento theme (replaces existing)
3. **Commit all today's changes** — git add all modified files → commit → push → Render auto-deploys
4. **Update Render env vars** — `MAGENTO_BEARER_TOKEN=rotg25kq42etlk4wsf7dnw6p5fz1ql4e` in Render Dashboard
5. **Test end-to-end on test.visor.no** — open widget → Monteringsveiledninger → real order + email → confirm product name/SKU/button layout → click button → product page opens with "Hvordan ta mål og montere" tab open + scrolled

---

## 8. Important Notes & Gotchas

| Topic | Note |
|---|---|
| **Widget bundle upload** | After `npm run build:widget`, the file `client/dist/widget.bundle.umd.js` must be manually uploaded to Magento media. Path on store: `https://test.visor.no/media/tekmetric/js/widget.bundle.js` |
| **React on CDN** | Widget injects React from `unpkg.com` if not present on page. Handles Magento's script URL rewriting. External React keeps bundle size small. |
| **GUIDES_PAGE_URL hardcoded** | `ChatWidget.jsx` line 13: URL `https://test.visor.no/how-to-install/` is hardcoded. Change this if going to production domain. |
| **RAG: relevance-first** | Retrieval sorts by similarity score + keyword boost (no recency). Recency was removed because newer ticket uploads were burying older FAQs. |
| **Ticket fallback trigger** | Agent skips KB and returns ticket answer directly (not as tool result context) — it `return`s early from inside the `rag_search` tool case. This means the GPT-4o generation step is bypassed. |
| **Substantive KB check** | Specific Norwegian keywords hardcoded in `hasSubstantiveKbContext()`: `vipps`, `plisse`, `rullegardin`, etc. If new product categories are added, this list may need updating. |
| **Install videos mapping** | File: `server/data/installVideos.json` — written at runtime when admin uploads `install_videos.csv`. Not in git. If this file is missing, API returns 400. |
| **Category matching priority** | (1) exact byCategoryId → (2) exact byCategoryKey → (3) fuzzy name substring → (4) order line text fallback (SKU/name keywords) → (5) general fallback |
| **Magento order ID** | Always use `increment_id` (e.g. `100045`), not internal `entity_id`. Customers see increment_id in their order confirmation email. |
| **Session store** | In-memory only — all sessions cleared on server restart. No data loss risk for users (widget re-creates conversation), but order lookup cache clears. |
| **CORS** | Currently allows ALL origins (`callback(null, true)`). Tighten before production by uncommenting the restricted callback. |
| **Admin auth** | `ADMIN_API_KEY` compared as a plain string bearer token. Not JWT-signed. Simple but fine for internal use. |
| **Render deploy** | Push to `feature/widget-installation-guides` → Render auto-deploys. Env vars must be set in Render Dashboard separately (not synced from `.env`). |
| **ngrok tunnel name** | `ngrok start ai-agent` — requires a named tunnel configured in ngrok config. The free-tier URL is `https://sinkerless-sententially-abrielle.ngrok-free.dev`. |

---

## 9. File Structure (Key Files)

```
ai-agent-hybrid/
├── CLAUDE.md                         ← THIS FILE — update before every push
├── CHANGELOG.md                      ← Full phase-by-phase history of the project
├── START.md                          ← How-to-start guide (untracked, decide: commit or gitignore)
│
├── server/                           ← Node.js/Express backend (PORT 5000)
│   ├── server.js                     ← Main entry: mounts all routes, multer, CORS, error handlers
│   ├── package.json                  ← scripts: dev (nodemon), start, build:admin, ingest-faqs
│   ├── .env                          ← SECRET KEYS — not committed, see section 10
│   │
│   ├── agents/
│   │   ├── visorAgent.js             ← MAIN BRAIN: GPT-4o + RAG + ticket fallback + order tools
│   │   ├── ragAgent.js               ← Standalone RAG (used by /rag test route only)
│   │   └── chatAgent.js              ← Simple chat (used by /chat route only)
│   │
│   ├── routes/
│   │   ├── visorRoute.js             ← POST /visor-chat — main chat endpoint
│   │   ├── fileRoute.js              ← POST /ingest and /api/ingest — file upload + Pinecone ingest
│   │   ├── chatRoute.js              ← POST /chat — general chat (not Visor-specific)
│   │   ├── envVerifyRoute.js         ← GET /api/verify-env (admin only)
│   │   └── orderInstallGuidesRoute.js ← POST /api/order/install-guides ★ NEWEST ROUTE
│   │
│   ├── tools/
│   │   ├── getOrderDetailsTool.js    ← GPT tool: fast cached order lookup (local JSON)
│   │   └── getOrderStatusTool.js     ← GPT tool: live Magento REST API call
│   │
│   ├── utils/
│   │   ├── embeddingService.js       ← Pinecone: initializePinecone, embedAndStore, searchSimilar
│   │   ├── fileParser.js             ← Parses PDF/JSON/CSV/TXT; detects FAQ format; parses install_videos
│   │   ├── textSplitter.js           ← LangChain RecursiveCharacterTextSplitter wrapper (1000 chars, 200 overlap)
│   │   ├── piiFilter.js              ← maskEmail, maskOrderId (for logs)
│   │   ├── securityLogger.js         ← Logs auth failures, rate limit hits, order lookups
│   │   └── ticketSearch.js           ← Searches Pinecone for ticket chunks only (source === filename)
│   │
│   ├── middlewares/
│   │   ├── auth.js                   ← requireAdminAuth: checks Authorization: Bearer <ADMIN_API_KEY>
│   │   ├── rateLimiter.js            ← globalLimiter (60/min), ingestLimiter (10/min)
│   │   ├── session.js                ← In-memory session cache, 24h TTL
│   │   └── validation.js             ← Request validation helpers
│   │
│   ├── config/
│   │   └── platform.js               ← Reads CMS_PLATFORM env; exports { platform, endpoints, auth }
│   │
│   ├── scripts/
│   │   ├── ingestFAQs.js             ← CLI: node scripts/ingestFAQs.js [path] — uploads FAQ JSON to Pinecone
│   │   └── ingestTickets.js          ← CLI: node scripts/ingestTickets.js [path] — uploads JSONL tickets
│   │
│   ├── data/
│   │   └── installVideos.json        ← GENERATED AT RUNTIME by admin ingest. NOT in git.
│   │                                    Structure: { general, byCategoryId, byCategoryKey }
│   │
│   └── public/
│       └── admin/                    ← Vite admin build output — run `npm run build:admin` to regenerate
│
└── client/                           ← React frontend
    ├── package.json                  ← scripts: build:widget (Vite UMD), start (CRA dev), build:admin
    ├── vite.config.js                ← Widget build: UMD format, external React/ReactDOM, CSS injected
    ├── .env                          ← REACT_APP_API_BASE_URL, REACT_APP_ADMIN_TOKEN
    │
    ├── src/
    │   ├── widget.jsx                ← Widget entry point: CDN React loader, VisorAIWidget global init
    │   ├── widget-styles.js          ← ALL widget CSS as a JS string (injected at runtime into <style>)
    │   ├── App.js                    ← CRA dev app entry (not used in production embed)
    │   └── components/
    │       ├── ChatWidget.jsx         ← Main container: 5 option flows, order/install forms, state mgmt
    │       ├── ChatWidget.css         ← Widget layout styles
    │       ├── ChatMessage.jsx        ← Renders messages + videoEmbeds (Vimeo/YouTube iframes)
    │       ├── ChatMessage.css        ← Responsive iframe styles
    │       └── AdminPanel.jsx         ← File upload UI, test query, upload logs (admin mode)
    │
    ├── admin/                         ← Separate Vite+React admin dashboard app
    │   ├── vite.config.js
    │   ├── main.jsx
    │   ├── AdminDashboard.jsx         ← Upload UI, Pinecone clear, env verify
    │   └── AdminDashboard.css
    │
    └── dist/                          ← Widget build output (gitignored)
        └── widget.bundle.umd.js       ← Upload this file to Magento media after every widget change
```

---

## 10. Environment Variables (server/.env)

```env
# Required — AI
OPENAI_API_KEY=sk-proj-...

# Required — Vector DB
PINECONE_API_KEY=pcsk_...
PINECONE_INDEX_NAME=ai-agent-knowledge

# Required — Admin auth
ADMIN_API_KEY=cc27f8289cc38851d90bee0956744cc021b0795a23599ab0e743fd1fb7338eb0

# Required — Magento
CMS_PLATFORM=magento
MAGENTO_API_URL=https://test.visor.no/rest/V1
MAGENTO_BEARER_TOKEN=0t87prppq95582mcb3lt14f7jqyyzfhv

# Optional — WooCommerce (not used when CMS_PLATFORM=magento)
WOOCOMMERCE_CONSUMER_KEY=ck_...
WOOCOMMERCE_CONSUMER_SECRET=cs_...
WORDPRESS_API_URL=https://...

# Optional
MAX_FILE_SIZE_MB=10
PORT=5000
DEBUG_MODE=true
```

**client/.env:**
```env
REACT_APP_API_BASE_URL=https://sinkerless-sententially-abrielle.ngrok-free.dev
REACT_APP_ADMIN_TOKEN=cc27f8289cc38851d90bee0956744cc021b0795a23599ab0e743fd1fb7338eb0
```

---

## 11. How to Run (3 Terminals)

```bash
# Terminal 1 — Backend
cd server && npm run dev
# → http://localhost:5000

# Terminal 2 — ngrok tunnel (so Magento can reach localhost)
ngrok start ai-agent
# → https://sinkerless-sententially-abrielle.ngrok-free.dev → localhost:5000

# Terminal 3 — Frontend dev app (optional, for testing widget locally)
cd client && npm start
# → http://localhost:3000
```

**After changing widget UI (client/src/components/):**
```bash
cd client && npm run build:widget
# → dist/widget.bundle.umd.js
# Upload this file to: Magento Admin → Content → Media → tekmetric/js/
```

**After changing admin dashboard (client/admin/):**
```bash
cd server && npm run build:admin
# → server/public/admin/ (auto-served at https://...onrender.com/admin)
```

---

## 12. API Routes Quick Reference

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/` | No | Health check |
| POST | `/visor-chat` | No | Main chat (RAG + order tools) |
| POST | `/chat` | No | General chat (no Visor context) |
| POST | `/ingest` | No | File upload + Pinecone ingest (legacy) |
| POST | `/api/ingest` | No | File upload + Pinecone ingest (rate limited) |
| POST | `/api/order/install-guides` | No | Installation videos for an order |
| GET | `/api/verify-env` | Admin | Check env vars + API connectivity |
| GET/POST/DELETE | `/api/pinecone/clear` | Admin | Delete all Pinecone vectors |
| GET | `/api/pinecone/debug` | Admin | Inspect vectors in Pinecone |
| GET | `/api/pinecone/test-search` | Admin | Test semantic search (`?q=query`) |
| GET | `/api/sessions` | Admin | View active sessions (PII masked) |
| GET | `/admin` | No | Admin dashboard SPA |
| POST | `/upload` | No | Raw file upload (no ingest) |
| GET/POST | `/rag` | No | Test RAG directly |

---

## 13. Session End Checklist

Before ending every work session, do this:

```bash
# 1. Update CLAUDE.md sections 4, 5, 6, 7 with what you did today

# 2. Commit everything
git add CLAUDE.md
git add <other changed files>
git commit -m "your work description"

# 3. Push
git push origin feature/widget-installation-guides
# → Render auto-deploys production
```

**On a new/other machine, to continue:**
```bash
git pull origin feature/widget-installation-guides
# Open CLAUDE.md, read sections 4-7
# Tell Claude: "Read CLAUDE.md and let's continue"
```
