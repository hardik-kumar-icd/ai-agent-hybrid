# New Machine Setup Guide

## Step 1 — Prerequisites Install Karo

```bash
# Node.js (v18+) check karo
node -v

# Agar nahi hai to install karo:
# https://nodejs.org → LTS version download karo

# Git check karo
git -v
```

---

## Step 2 — Repo Clone Karo

```bash
git clone https://github.com/TechAnkushLodhi/ai-agent-hybrid.git
cd ai-agent-hybrid
git checkout feature/widget-installation-guides
```

Username/password maange to:
- Username: `TechAnkushLodhi`
- Password: GitHub Personal Access Token (Settings → Developer Settings → Tokens → Generate new token (classic) → repo scope)

---

## Step 3 — Dependencies Install Karo

```bash
# Server dependencies
cd server
npm install

# Client dependencies
cd ../client
npm install

# Root pe wapas jao
cd ..
```

---

## Step 4 — Environment Files Banao

### server/.env
```bash
cd server
nano .env
```

Ye content paste karo:
```env
ADMIN_API_KEY=cc27f8289cc38851d90bee0956744cc021b0795a23599ab0e743fd1fb7338eb0
REACT_APP_ADMIN_TOKEN=cc27f8289cc38851d90bee0956744cc021b0795a23599ab0e743fd1fb7338eb0

OPENAI_API_KEY=sk-proj-...apni key...

PINECONE_API_KEY=pcsk_...apni key...
PINECONE_ENVIRONMENT=us-east1-gcp
PINECONE_INDEX_NAME=ai-agent-knowledge

CMS_PLATFORM=magento
MAGENTO_API_URL=https://test.visor.no/rest/V1
MAGENTO_BEARER_TOKEN=rotg25kq42etlk4wsf7dnw6p5fz1ql4e

MAX_FILE_SIZE_MB=10
PORT=5000
JWT_SECRET=my-super-secret-key
DEBUG_MODE=true
```

### client/.env
```bash
cd ../client
nano .env
```

Ye content paste karo:
```env
REACT_APP_API_BASE_URL=http://localhost:5000
REACT_APP_ADMIN_TOKEN=cc27f8289cc38851d90bee0956744cc021b0795a23599ab0e743fd1fb7338eb0
```

---

## Step 5 — Server Start Karo

```bash
cd server
npm run dev
# → http://localhost:5000 pe chalega
```

---

## Step 6 — ngrok Start Karo (Magento ke liye)

Agar ngrok nahi hai:
```bash
# Download: https://ngrok.com/download
# Account banao → Auth token lo

ngrok config add-authtoken <your-token>
```

Named tunnel ke liye `~/.config/ngrok/ngrok.yml` mein add karo:
```yaml
tunnels:
  ai-agent:
    proto: http
    addr: 5000
```

Phir start karo:
```bash
ngrok start ai-agent
```

---

## Step 7 — client/.env Update Karo (ngrok URL se)

```bash
cd client
nano .env
```

`REACT_APP_API_BASE_URL` ko ngrok URL se replace karo:
```env
REACT_APP_API_BASE_URL=https://xxxx-xxxx.ngrok-free.dev
```

---

## Step 8 — Widget Build Karo (Optional)

Agar widget mein changes kiye hain:
```bash
cd client
npm run build:widget
# → client/dist/widget.bundle.umd.js
# Ye file Magento pe upload karni hogi
```

---

## Step 9 — Test Karo

- Local widget: `http://localhost:3000` (alag terminal mein `cd client && npm start`)
- Backend API: `http://localhost:5000`
- Admin panel: `http://localhost:5000/admin`

---

## Quick Reference

| Kaam | Command |
|---|---|
| Server start | `cd server && npm run dev` |
| ngrok start | `ngrok start ai-agent` |
| Widget build | `cd client && npm run build:widget` |
| Admin build | `cd server && npm run build:admin` |
| Push to GitHub | `git push ankush feature/widget-installation-guides` |

---

## Claude Ko Context Dena

Naye machine pe Claude se kaam shuru karte waqt ye bolo:
```
"Read CLAUDE.md and let's continue"
```

Claude poora context samajh lega — kya ho chuka hai, kya baaki hai.
