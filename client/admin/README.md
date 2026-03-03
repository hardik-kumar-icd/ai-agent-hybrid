# Visor AI Admin Dashboard (SPA)

This folder contains a small React + Vite **admin dashboard** that is built and served from the **same Render service** as the main AI Agent Hybrid backend.

The dashboard lives at `/admin` and talks to existing backend admin APIs:

- `POST /api/ingest` – file ingestion (PDF, CSV, JSON, TXT)
- `GET /api/verify-env` – environment verification
- `DELETE /api/pinecone/clear` – clear Pinecone index
- `GET /api/pinecone/test-search` – test semantic search

## Project layout

- `client/admin/index.html` – HTML shell with `#root` container
- `client/admin/main.jsx` – React entry, renders `AdminDashboard`
- `client/admin/AdminDashboard.jsx` – main dashboard component
- `client/admin/AdminDashboard.css` – minimal, self-contained styling
- `client/admin/vite.config.js` – Vite config that builds into `server/public/admin`

All admin code is isolated under `client/admin/` and does **not** import or modify the existing widget code under `client/src/`.

## Build configuration

The admin app uses a dedicated Vite config:

- **Root**: `client/admin`
- **Base**: `/admin/` (so assets load correctly when served from `/admin`)
- **Output**: `../../server/public/admin` (resolved to `server/public/admin`)

When you run:

```bash
cd client/admin
npx vite build
```

Vite emits static files into `server/public/admin`, for example:

- `server/public/admin/index.html`
- `server/public/admin/assets/*`

## Express integration

The Express server (`server/server.js`) serves the admin dashboard via:

```js
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});
```

This is added **after** all API routes (`/api/...`), so it will not interfere with the existing JSON APIs or the `/visor-chat` endpoint.

## Security model

- All admin endpoints are already protected server-side with `requireAdminAuth` and `ADMIN_API_KEY`.
- The dashboard:
  - Prompts for the **Bearer token** (your `ADMIN_API_KEY` from Render) in a password-like input.
  - Keeps the token **only in React state** – it is **not** written to `localStorage`, `sessionStorage`, cookies, or any file.
  - Sends the token on each request as `Authorization: Bearer <token>`.

If the token is missing or invalid, the APIs respond with 401 and the UI shows a clear error message.

## Render deployment

On Render, make sure your build process also builds the admin dashboard. One simple approach:

1. In your Render service settings, use a build command similar to:

   ```bash
   cd client && npm install
   npm run build:widget
   cd admin && npx vite build
   cd ../../server && npm install
   ```

2. Ensure `ADMIN_API_KEY` is set in the Render **Environment** tab – this is the token you paste into the dashboard.

3. After deployment, the dashboard is available at:

   ```text
   https://<your-render-service>.onrender.com/admin
   ```

## Usage

1. Navigate to `/admin` in your browser.
2. Paste your `ADMIN_API_KEY` into the token field.
3. Use:
   - **File Ingestion** to upload PDFs/JSON/CSV/TXT to `POST /api/ingest`.
   - **Verify Environment** to call `GET /api/verify-env`.
   - **Clear Pinecone Index** (use carefully) to call `DELETE /api/pinecone/clear`.
   - **Test Search** to hit `GET /api/pinecone/test-search?q=...` and inspect retrieved RAG results.

The widget bundle and all existing frontend/backend behaviour remain unchanged by this admin module.

