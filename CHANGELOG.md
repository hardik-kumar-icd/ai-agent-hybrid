# Changelog - AI Agent Hybrid Project

A comprehensive documentation of the project's evolution, features, and implementation details.

---

## Phase 1: Project Setup & Core Technologies

### Initial Setup

**Backend Stack:**
- **Node.js** with **Express.js 5.2.1** - RESTful API server
- **TypeScript/JavaScript** - CommonJS modules
- **dotenv** - Environment variable management
- **CORS** - Cross-origin resource sharing enabled

**Frontend Stack:**
- **React 18.2.0** - UI library
- **React Scripts 5.0.1** - Build tooling
- **Vite 7.3.1** - Fast widget bundler (replaced Webpack)

**Development Tools:**
- **Nodemon** - Auto-restart for development
- **Multer** - File upload handling
- **Axios** - HTTP client

### Project Structure

```
server/
├── agents/          # AI agent implementations
├── config/          # Platform configurations
├── middlewares/     # Express middlewares
├── routes/          # API route handlers
├── tools/           # OpenAI function tools
└── utils/           # Utility functions

client/
├── src/
│   ├── components/  # React components
│   └── widget.jsx    # Embeddable widget entry
└── dist/             # Built widget bundle
```

---

## Phase 2: Langchain & Pinecone Integration

### Langchain Integration

**Purpose:** Orchestrate AI workflows and manage document processing

**Key Components:**
- `@langchain/openai` (v1.2.2) - OpenAI integration
- `@langchain/textsplitters` (v1.0.1) - Document chunking
- **OpenAIEmbeddings** - Text embedding generation using `text-embedding-3-large` model (3072 dimensions)

**Usage:**
- Document text splitting and chunking
- Embedding generation for vector storage
- Semantic search query processing

### Pinecone Vector Database

**Purpose:** Store and retrieve document embeddings for RAG (Retrieval-Augmented Generation)

**Configuration:**
- **SDK:** `@pinecone-database/pinecone` v6.1.3
- **Index Type:** Serverless (AWS)
- **Metric:** Cosine similarity
- **Dimensions:** 3072 (matching OpenAI's text-embedding-3-large)

**Key Features:**
- Automatic index creation if missing
- Namespace support for data isolation
- Efficient vector similarity search
- Metadata storage (source, timestamps, text content)

**Core Functions:**
- `initializePinecone()` - Initialize client and index
- `embedAndStore()` - Generate embeddings and store vectors
- `searchSimilar()` - Semantic search with recency prioritization
- `deleteAllVectors()` - Clear index/namespace

### Basic Chat API

**Endpoint:** `POST /visor-chat`

**Features:**
- Conversation ID tracking via `X-Conversation-Id` header
- Session-based message history
- Multilingual support (auto-detect user language)
- JSON-only responses

**Request:**
```json
{
  "message": "User query",
  "conversationId": "conv-1234567890-abc123"
}
```

**Response:**
```json
{
  "reply": "AI response",
  "conversationId": "conv-1234567890-abc123"
}
```

---

## Phase 3: RAG (Retrieval-Augmented Generation) & Ingestion

### RAG Workflow

**Process Flow:**
1. User query received
2. Generate query embedding using OpenAI
3. Search Pinecone for similar vectors (fetch 5x topK for recency)
4. Prioritize recent uploads by timestamp
5. Retrieve top-k relevant chunks
6. Inject context into AI prompt
7. Generate response using GPT-4 with context

**Key Features:**
- **Recency Prioritization:** New uploads prioritized over old data
- **Semantic Understanding:** Handles field name variations (e.g., "regular_price" vs "regular-price")
- **Transparency:** Explicitly states when knowledge base data is unavailable
- **No Hallucination:** Strictly uses RAG results, no training data fallback

### Ingestion API

**Endpoint:** `POST /api/ingest`

**Authentication:** Bearer token (admin only)

**Supported Formats:**
- PDF (`.pdf`)
- JSON (`.json`)
- CSV (`.csv`)
- Text (`.txt`)

**Process:**
1. File upload via Multer
2. Parse file based on format
3. Split text into chunks (configurable chunk size)
4. Generate embeddings for each chunk
5. Store vectors in Pinecone with metadata
6. Return success confirmation

**Response:**
```json
{
  "success": true,
  "message": "File processed successfully",
  "chunks": 150,
  "sourceName": "product-catalog-2024"
}
```

**File Parsing:**
- **PDF:** Extracts text using `pdf-parse`
- **JSON:** Parses structured data, extracts text fields
- **CSV:** Converts rows to text chunks
- **Text:** Direct chunking

**Text Splitting:**
- Uses Langchain's `RecursiveCharacterTextSplitter`
- Chunk size: 1000 characters
- Overlap: 200 characters
- Preserves document structure

### RAG Agent Implementation

**File:** `server/agents/ragAgent.js`

**Function:** `ragAgent(message)`

**Workflow:**
1. Generate query embedding
2. Search Pinecone (topK=3, but fetches 15+ for recency)
3. Filter and prioritize by upload timestamp
4. Build context from top results
5. Call OpenAI with RAG context
6. Return formatted response

**Error Handling:**
- Returns "NO_KNOWLEDGE_BASE_DATA" when no results found
- Handles Pinecone connection errors
- Manages OpenAI API failures

---

## Phase 4: Order Management APIs

### Order Tools

**Two Separate Tools:**

1. **`get_order_details`** (Cached)
   - Fast lookup from local cache
   - Returns: order_id, status, tracking, delivery_date
   - No price/currency information (security)

2. **`get_order_status`** (Live API)
   - Real-time WooCommerce API call
   - Fallback when cache misses
   - Same response format

### Order API Endpoints

**Main Endpoint:** `POST /visor-chat` (uses order tools via function calling)

**Order Data Source:**
- Local JSON file: `server/data/orders.json`
- WooCommerce API (fallback)

### Order Workflow

**Process:**
1. User asks about order (e.g., "What is status of order #90948?")
2. Agent extracts order_id and email from message
3. If missing, asks for missing parameter in user's language
4. Calls `get_order_details` first (cached, faster)
5. If fails, calls `get_order_status` (live API)
6. Returns order information (status, tracking, delivery date)
7. **Never returns:** price, currency, billing address, PII

**Security:**
- Requires both order_id AND email verification
- Price information filtered out
- Customer PII not exposed

**Language Support:**
- Detects user language automatically
- Responds in same language as query
- Handles Norwegian and English

---

## Phase 5: Security Implementation

### Authentication

**Admin Authentication:**
- **Middleware:** `server/middlewares/auth.js`
- **Method:** Bearer token (JWT)
- **Token Source:** `ADMIN_API_KEY` environment variable
- **Protected Routes:** `/api/ingest`, `/api/pinecone/*`

**Implementation:**
```javascript
const requireAdminAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token === process.env.ADMIN_API_KEY) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};
```

### Rate Limiting

**Middleware:** `server/middlewares/rateLimiter.js`

**Two Limiters:**

1. **Global Limiter:**
   - 60 requests per minute per IP
   - Applied to all routes
   - Response includes `retry_after` seconds

2. **Ingest Limiter:**
   - 10 requests per minute per IP
   - Applied to `/api/ingest` route
   - Prevents abuse of file upload

**Response Format:**
```json
{
  "error": "Too many requests, please try again later.",
  "retry_after": 45
}
```

**Configuration:**
- Uses `express-rate-limit` package
- Trust proxy enabled for accurate IP detection
- JSON-only error responses

### PII (Personally Identifiable Information) Filtering

**File:** `server/utils/piiFilter.js`

**Purpose:** Mask sensitive information in logs and responses

**Filtered Data:**
- Email addresses (e.g., `test@example.com` → `t***@example.com`)
- Order IDs (e.g., `90948` → `9***8`)

**Usage:**
- Applied to request logging
- Used in error messages
- Prevents PII exposure in logs

**Implementation:**
```javascript
function maskEmail(email) {
  return email.replace(/(.{1})(.*)(@.*)/, '$1***$3');
}

function maskOrderId(orderId) {
  return orderId.replace(/(.{1})(.*)(.{1})/, '$1***$3');
}
```

### Session Management

**Middleware:** `server/middlewares/session.js`

**Features:**
- In-memory session cache
- Conversation ID tracking
- Message history storage
- Automatic cleanup (24-hour TTL)

**Session Structure:**
```javascript
{
  conversationId: "conv-1234567890-abc123",
  messages: [...],
  createdAt: timestamp,
  lastAccessed: timestamp
}
```

**Benefits:**
- Context preservation across messages
- Faster order lookups (cached)
- Conversation continuity

### Security Logging

**File:** `server/utils/securityLogger.js`

**Purpose:** Log security events and suspicious activities

**Logged Events:**
- Failed authentication attempts
- Rate limit violations
- Unauthorized access attempts
- File upload errors

### Error Handling

**Features:**
- Consistent JSON error responses
- No HTML error pages
- Detailed error messages (development)
- Sanitized error messages (production)
- Multer error handling (file size limits)

**Error Response Format:**
```json
{
  "success": false,
  "error": "Error type",
  "message": "Detailed error message"
}
```

---

## Phase 6: Frontend Widget Implementation

### Widget Architecture

**Technology Stack:**
- **React 18.2.0** - Component library
- **Vite 7.3.1** - Build tool (replaced Webpack)
- **UMD Format** - Universal module definition for embedding
- **External React** - Loaded from CDN (not bundled)

### Widget Build Process

**Entry Point:** `client/src/widget.jsx`

**Build Configuration:** `client/vite.config.js`

**Key Settings:**
- UMD output format
- External React/ReactDOM (CDN)
- CSS inlined in bundle
- `process.env` defined as empty object (browser-safe)

**Build Command:**
```bash
cd client
npm run build:widget
```

**Output:**
- `dist/widget.bundle.umd.js` - Main widget bundle
- `dist/widget.bundle.css` - Optional CSS file (styles injected automatically)

### Widget Features

**Two Modes:**

1. **User Mode** (Default)
   - Chat interface
   - Message history
   - Conversation persistence (localStorage)
   - Typing indicators
   - Error handling

2. **Admin Mode**
   - File upload interface
   - Knowledge base management
   - Upload logs
   - Test query functionality

**Styling:**
- CSS injected programmatically (no separate file needed)
- Customizable theme colors via data attributes
- Responsive design (mobile-friendly)
- Smooth animations

### Widget Integration

**WordPress/Magento Integration:**

**HTML:**
```html
<div id="visor-ai-widget"
     data-base-url="https://your-api-url.com"
     data-admin="false"
     data-theme-color="#667eea"
     data-accent-color="#764ba2">
</div>
```

**Scripts:**
```html
<!-- React 18.2.0 CDN (Required) -->
<script crossorigin src="https://unpkg.com/react@18.2.0/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js"></script>

<!-- Widget Bundle -->
<script src="widget.bundle.js"></script>

<!-- Initialize -->
<script>
window.VisorAIWidget.initFromElement('#visor-ai-widget');
</script>
```

**Configuration Options:**
- `data-base-url` - API endpoint URL
- `data-admin` - "true" for admin mode, "false" for user mode
- `data-token` - Admin token (admin mode only)
- `data-theme-color` - Primary color (hex)
- `data-accent-color` - Accent color (hex)

### Widget Components

**ChatWidget.jsx:**
- Main container component
- Toggle open/close
- Message rendering
- Input handling
- Admin/User mode switching

**ChatMessage.jsx:**
- Individual message rendering
- User/Assistant styling
- Markdown support
- Typing indicator

**AdminPanel.jsx:**
- File upload interface
- Upload progress tracking
- Test query functionality
- Upload logs display

### Widget Initialization

**Global API:**
```javascript
window.VisorAIWidget = {
  init(options),
  initFromElement(selector)
}
```

**Initialization Process:**
1. Check React/ReactDOM availability
2. Retry if not ready (with timeout)
3. Read configuration from data attributes
4. Create React root
5. Render widget component
6. Inject CSS styles

**Error Handling:**
- Dependency checking
- Retry mechanism
- Console logging for debugging
- Graceful degradation

---

## Additional Features

### Environment Verification

**Endpoint:** `GET /api/env-verify`

**Purpose:** Check configuration status

**Checks:**
- OpenAI API connectivity
- Pinecone connection
- WooCommerce API (if configured)
- Environment variables

**Response:**
```json
{
  "openai": "active",
  "pinecone": "active",
  "woocommerce": "not_configured"
}
```

### Pinecone Management APIs

**Debug Endpoint:** `GET /api/pinecone/debug`
- Lists vectors in index
- Shows metadata
- Counts total vectors

**Clear Endpoint:** `GET/POST/DELETE /api/pinecone/clear`
- Clears all vectors from index
- Optional namespace parameter
- Admin authentication required

**Test Search:** `GET /api/pinecone/test-search`
- Test semantic search functionality
- Returns sample results

### File Upload Features

**Supported File Types:**
- PDF documents
- JSON data files
- CSV spreadsheets
- Plain text files

**Upload Limits:**
- Configurable via `MAX_FILE_SIZE` environment variable
- Default: 10MB
- Multer error handling

**Processing:**
- Automatic format detection
- Text extraction
- Chunking and embedding
- Metadata preservation

---

## API Summary

### Public Endpoints

- `POST /visor-chat` - Main chat endpoint
- `GET /api/env-verify` - Environment verification
- `POST /api/order/install-guides` - Installation videos for a Magento order (requires `order_id` + `email`; uses `server/data/installVideos.json` from admin mapping ingest)

### Admin Endpoints (Bearer Token Required)

- `POST /api/ingest` - File upload and ingestion
- `GET /api/pinecone/debug` - Debug Pinecone index
- `GET/POST/DELETE /api/pinecone/clear` - Clear Pinecone index
- `GET /api/pinecone/test-search` - Test semantic search

---

## Environment Variables

### Required

```env
OPENAI_API_KEY=sk-...
PINECONE_API_KEY=...
PINECONE_INDEX_NAME=your-index-name
ADMIN_API_KEY=your-admin-token
```

### Optional

```env
PINECONE_REGION=us-east-1
MAX_FILE_SIZE=10485760
PORT=3000
```

---

## Development Workflow

### Backend

```bash
cd server
npm install
npm run dev  # Development with nodemon
npm start    # Production
```

### Frontend

```bash
cd client
npm install
npm start           # Development server
npm run build       # Production build
npm run build:widget # Widget bundle
```

### Admin UI (`client/admin`)

- **Vite + React** dashboard; build output is served by Express from **`server/public/admin`** at **`/admin`**. Ingest calls use **Axios `timeout: 120000` (2 minutes)** so large or slow jobs are less likely to abort client-side.

---

## Widget UX Updates (Chat Header & Input)

- **Header actions:** Restart chat and Download transcript icons added to chat header. Hover tooltips: "Restart chat", "Download transcript". Restart clears messages and starts a new conversation; Download exports conversation as a `.txt` file.
- **Welcome message:** Initial greeting ("Hei! Jeg er Visor.no assistenten...") is now shown as a normal assistant chat bubble instead of a centered placeholder.
- **Placeholder language:** Input placeholder switches from Norwegian ("Skriv din melding her...") to English ("Type your message here...") when the user’s first message is detected as English (keyword-based).
- **Order-related messages:** If the user’s message looks like an order-status question (Norwegian/English keywords), the widget opens the **Order Status** flow immediately (form only, no extra assistant reply) so they can enter email and order number without waiting on a chat turn.

---

## Order installation videos (Magento)

**Purpose:** After purchase, customers can open **Installation guides** in the widget, enter **order number** and **email**, and see **Vimeo (or other) installation videos** matched to the product categories on that order.

### Admin: video mapping ingest

- Upload a mapping file via the existing admin **`POST /ingest`** flow (same bearer auth as other uploads).
- **Supported filenames:** `install_videos.csv`, `install_videos.txt` (and **`install_guides.txt` / `.csv`** as an alias for older naming).
- **Formats:** CSV with headers (e.g. `category`, `url`, `title`, `category_id`), loose delimiter parsing, or **block** format (category line followed by URL lines). Raw file read preserves newlines (not passed through generic `extractText()` normalization).
- **Output:** `server/data/installVideos.json` with optional **`general`** fallback, **`byCategoryId`** (numeric Magento category IDs), and **`byCategoryKey`** (normalized keys for category names / labels).

### API: resolve videos for an order

- **`POST /api/order/install-guides`** — Body: `{ "order_id": "<increment_id>", "email": "<customer email>" }`.
- Loads the order from Magento by **increment_id**, verifies **email** matches the order, then for each line item resolves **product → category IDs → category names** and picks a video from the mapping (exact ID, exact name key, fuzzy name match, then **general**).
- If the Magento **catalog** REST API returns **401** (integration can read orders but not products), category IDs may be empty: the handler falls back to **order-line text** (SKU/name keywords, e.g. plisse → plissegardiner) when possible, otherwise **general**.
- Response includes **`videos`** (deduped by URL) and optional **`debug`** (per-item steps, mapping stats) for troubleshooting.

### Widget UX

- Third option button: **Installation guides** / **Monteringsvideoer** (alongside Order status and How do I order?). Uses the **same** email + order ID form as order status; submit calls **`/api/order/install-guides`** instead of the chat agent.
- **ChatMessage:** Assistant messages can include **`videoEmbeds`** — embedded iframes (Vimeo URLs normalized to `player.vimeo.com`) with titles and responsive layout (**`ChatMessage.css`** / **`widget-styles.js`**).

---

## FAQ Ingestion System

- **FAQ JSON Parser:** Enhanced JSON parser in `fileParser.js` to detect and parse FAQ structure. Automatically formats FAQs as "Category: [category]. Question: [question]. Answer: [answer]" for optimal searchability.
- **Ingestion Script:** Created `server/scripts/ingestFAQs.js` to ingest FAQ JSON files into Pinecone. Usage: `npm run ingest-faqs` or `node server/scripts/ingestFAQs.js [path-to-faq-file]`. Defaults to `visor_faqs.json` in project root.
- **RAG Integration:** FAQs are automatically available to the agent via the existing RAG system. When users ask FAQ-related questions, the agent searches Pinecone and responds using the ingested FAQ content.
- **Format:** Each FAQ is stored as separate chunks with category context, enabling precise semantic search and retrieval.

---

## Support Tickets Integration (Mirasvit) & RAG Improvements

- **Ticket ingestion:** Added `server/scripts/ingestTickets.js` to ingest Mirasvit support tickets from JSONL (e.g. `tickets_fixed.jsonl`). Each admin reply is stored with paired customer context for retrieval. Usage: `node server/scripts/ingestTickets.js [path-to-jsonl]`.
- **Ticket search:** New `server/utils/ticketSearch.js` filters Pinecone results to ticket chunks only (`source === 'tickets_fixed.jsonl'`), so ticket-based answers are opt-in and do not pollute FAQ/product RAG.
- **Ticket-based answers:** When the knowledge base has no substantive answer (empty or only generic "Fant ikke svar" contact FAQ), the agent falls back to `answerFromTickets()`: retrieves similar ticket chunks, sanitizes PII, and uses the main model to synthesize an answer from those examples in the user's language.
- **Strong ticket match:** When the KB has data but a ticket is a very strong match (semantic score ≥ 0.65 or user query is a substring of a ticket chunk), the agent prefers the ticket-based answer so support-style questions (e.g. befaring, rabattkode, tilbud/frakt) use historical tickets.
- **Substring match:** If the user's message appears verbatim inside a ticket chunk (e.g. copy-paste from a ticket), the ticket path is used regardless of score.
- **Cross-lingual tickets:** Ticket search uses expanded query and a 0.65 score threshold so English questions can match Norwegian ticket chunks and get an answer in English.
- **Mandatory rag_search:** System prompt and tool description updated so the model must call `rag_search` for every user question (all languages), avoiding answers from memory when RAG/tickets could answer.
- **RAG retrieval by relevance:** In `embeddingService.js`, retrieval now sorts by **similarity score** only (removed recency prioritization). FAQ and product chunks can surface for queries like "Vipps" or "tekstilprøver" even when tickets were ingested later.
- **LLM query expansion:** RAG uses `expandQueryForSearch()` (gpt-4o-mini) to expand the user query with alternative phrasings for retrieval; no static keyword lists. Reverted earlier static FAQ keyword injection in `fileParser.js`.
- **Debug logging removed:** Per-request debug logs (agent tool calls, RAG/ticket scores, session tool results) removed from `visorAgent.js` and `embeddingService.js`. Error logging (`console.error`) retained for failures.

---

## Key Design Decisions

1. **External React Loading:** Reduces bundle size, allows CDN caching
2. **CSS Injection:** Ensures styles always load, no separate CSS file needed
3. **Relevance-first RAG:** Results sorted by similarity score so FAQs and products surface for relevant queries; ticket fallback when KB has no substantive answer or ticket match is strong
4. **Dual Order Tools:** Cached + Live API for reliability
5. **PII Filtering:** Security-first logging approach
6. **Session Caching:** Improves performance and user experience
7. **Rate Limiting:** Protects server from abuse
8. **Multilingual Support:** Auto-detect and respond in user's language

---

## Future Enhancements

- [ ] Multi-language knowledge base support
- [ ] Advanced analytics and usage tracking
- [ ] Webhook support for real-time updates
- [ ] Custom tool creation API
- [ ] Enhanced admin dashboard
- [ ] Widget theming API
- [ ] Advanced search filters

---
