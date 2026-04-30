# SAMJHO.md — Yeh Project Kya Hai Aur Kaise Use Karein
> Yeh file non-developer ke liye likhi gayi hai. Simple bhasha mein sab kuch samjhaya gaya hai.

---

## PEHLE SAMJHO — Yeh Project Kya Hai?

**Ek line mein:** Yeh ek **chat widget** hai jo kisi bhi website (Magento ya WordPress) mein lagta hai, aur customers ke sawal ka jawab automatically deta hai — jaise ek smart customer service agent.

**Real life analogy:**
Socho ek Blinkit ya Meesho app hai. Neeche corner mein ek chat button hota hai — click karo toh ek assistant aata hai. Woh tumhare product ke sawal answer karta hai, order status batata hai. **Yahi cheez hum Visor.no ke liye bana rahe hain** — ek Norwegian blinds (parde/blinds) ki website ke liye.

---

## WIDGET KA DEMO — Kya Dikhta Hai Customer Ko?

Jab customer Visor.no pe jaata hai:

```
┌─────────────────────────────┐
│  Visor.no Assistant         │  ← Yeh chat window khulta hai
│─────────────────────────────│
│  Hei! Main aapka assistant  │
│  hun. Kya help chahiye?     │
│                             │
│  [FAQs aur sawal jawab]     │  ← 5 buttons dikhte hain
│  [Product Info]             │
│  [Order Status]             │
│  [Installation Guides]      │
│  [How do I order?]          │
└─────────────────────────────┘
                          💬  ← Yeh button hamesha screen ke corner mein hota hai
```

**Customer kuch bhi type kar sakta hai ya button click kar sakta hai:**

| Agar customer ne kiya... | Toh kya hoga |
|---|---|
| FAQs click kiya | Type karo sawal → AI answer dega Pinecone se (knowledge base) |
| Product Info click kiya | Product ke baare mein type karo → AI answer dega |
| Order Status click kiya | Email + Order number daalo → Magento se order status aayega |
| Installation Guides click kiya | Email + Order number daalo → Vimeo videos dikhenge (product ke hisaab se) |
| How do I order? click kiya | Ek CMS page khulega new tab mein (measuring/ordering guide) |

---

## TEEN MAIN CHEEZEIN SAMJHO

### Cheez 1: AI Brain (OpenAI)
**Kya hai:** OpenAI ek company hai (ChatGPT wali). Unka GPT-4o model hum use karte hain — yeh "brain" ka kaam karta hai.

**Kyun use kiya:** Kyunki yeh sabse smart freely available AI hai. Customer jo bhi type kare — Norwegian mein ya English mein — yeh samjhta hai aur jawab deta hai.

**Kab use hota hai:** Jab bhi customer kuch type karta hai — AI text padhta hai, tools call karta hai, phir response generate karta hai.

**Cost:** Har message pe paisa lagta hai (OpenAI API ke tokens). Isliye ek API key chahiye (`OPENAI_API_KEY`).

---

### Cheez 2: Knowledge Base (Pinecone)
**Kya hai:** Pinecone ek database hai — lekin normal database nahi. Yeh **meaning ke hisaab se** search karta hai, exact words se nahi.

**Simple analogy:** Normal Google Search = exact words dhundta hai. Pinecone = matlab samjhke dhundta hai. Customer "blind ka price" puchhe ya "parde kitne ke hain" — dono ko same answer milega.

**Kyun use kiya:** Product info, FAQs, installation guides — yeh sab documents Pinecone mein store hote hain. AI jawaab dene se pehle Pinecone mein dhundta hai — tabhi accurate answer milta hai.

**Kab use hota hai:** Har chat message pe — AI pehle Pinecone mein dhundta hai phir answer deta hai.

**Cost:** Pinecone ka free tier available hai. Zyada data ke liye paid plan.

---

### Cheez 3: Magento API
**Kya hai:** Magento ek e-commerce platform hai — jaise WooCommerce. Visor.no ka online store Magento pe chalta hai.

**Kyun use kiya:** Customer apna order number deta hai → hum Magento se real-time order data laate hain → customer ko status batate hain.

**Kab use hota hai:** Sirf tab jab customer Order Status ya Installation Guides maange aur email + order number de.

**Kaise connect hota hai:** Ek "Bearer Token" use hota hai — yeh ek secret key hai jo Magento admin se milti hai. Isse server Magento ka data padhh sakta hai.

---

## POORA FLOW — Ek Message Se Answer Tak

```
Customer ne likha: "What are your delivery options?"
         ↓
1. Widget (React) → Server ko bheja (POST /visor-chat)
         ↓
2. Server → visorAgent.js ko diya
         ↓
3. visorAgent.js → GPT-4o ko bheja
         ↓
4. GPT-4o bola: "Pehle knowledge base mein dhoondho"
         ↓
5. visorAgent.js → Pinecone mein search kiya "delivery options"
         ↓
6. Pinecone ne relevant FAQ/Product chunks wapas diye
         ↓
7. GPT-4o ne woh context padha + customer ka sawal padha
         ↓
8. GPT-4o ne English mein jawab banaya (language auto-detect)
         ↓
9. Widget pe customer ko jawab dikha
```

---

## KAISE TEST KAREIN — Step by Step

### Step 1: Server Start Karo

```bash
# Terminal 1 mein yeh likho:
cd /media/ankush/86bce185-ba1a-4f6f-8e1c-597842b3457a/Hyva/Visor/ai-agent-hybrid/server
npm run dev
```

Agar sahi se chala toh yeh dikhega:
```
Server is running on http://localhost:5000
```

Agar error aaya toh usually `.env` file missing hai — `server/.env` file check karo.

---

### Step 2: Basic Chat Test Karo (Browser mein)

Browser mein yeh URL kholo:
```
http://localhost:5000/
```
Agar `{"message":"Server is running!"}` dikhta hai — server theek hai ✅

---

### Step 3: Chat Test Karo (Postman ya curl se)

**Postman use karo (recommended — free tool, download karo getpostman.com):**

```
Method: POST
URL: http://localhost:5000/visor-chat
Body (JSON):
{
  "message": "What products do you have?"
}
```

Agar Pinecone mein kuch data nahi hai toh AI bolega: "I don't have that information in my knowledge base."
Agar data hai toh products batayega.

---

### Step 4: Knowledge Base Mein Data Daalo (Admin Panel)

Browser mein kholo: `http://localhost:5000/admin`

Yahan se:
1. **Upload file** — PDF, CSV, JSON ya TXT file upload karo (product info, FAQs, etc.)
2. File upload hone ke baad → Pinecone mein store ho jaata hai
3. Ab AI ke paas knowledge hai — dobara chat test karo

**Kya file upload karein?**
- `visor_faqs.json` — frequently asked questions
- Products CSV/PDF — product details, prices, dimensions
- `install_videos.csv` — installation video mapping (neeche explain kiya hai)

---

### Step 5: Order Status Test Karo

```
Method: POST
URL: http://localhost:5000/visor-chat
Body (JSON):
{
  "message": "Check order status for Order ID: 100045, Email: customer@visor.no"
}
```

Agar Magento connection sahi hai → real order data aayega
Agar 404 aaya → order Magento mein nahi mila ya email match nahi ki

---

### Step 6: Installation Guides Test Karo

Pehle `install_videos.csv` upload karo admin panel se. Phir:

```
Method: POST
URL: http://localhost:5000/api/order/install-guides
Body (JSON):
{
  "order_id": "100045",
  "email": "customer@visor.no"
}
```

Response mein `videos` array aayega Vimeo links ke saath.

---

## MAGENTO MEIN KAISE LAGAO (Widget Embed)

### Step 1: Widget Build Karo

```bash
cd client
npm run build:widget
```

Yeh ek file banata hai: `client/dist/widget.bundle.umd.js`

### Step 2: File Magento Mein Upload Karo

Magento Admin mein jaao:
- **Content → Media → Upload**
- File upload karo kisi folder mein (jaise `tekmetric/js/`)
- Note karo URL: `https://yourstore.com/media/tekmetric/js/widget.bundle.js`

### Step 3: Magento Template Mein Code Daalo

Magento Admin → Content → Blocks ya Pages → kisi page ka HTML edit karo, ya `copyright.phtml` file mein:

```html
<!-- 1. Widget ka container -->
<div id="visor-ai-widget"
     data-base-url="https://ai-agent-hybrid.onrender.com"
     data-admin="false">
</div>

<!-- 2. React library (required) -->
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>

<!-- 3. Widget bundle -->
<script src="https://yourstore.com/media/tekmetric/js/widget.bundle.js"></script>
```

**`data-base-url`** = Backend server ka URL
- Local testing ke liye: `https://ngrok-url.ngrok-free.app`
- Production ke liye: `https://ai-agent-hybrid.onrender.com`

### Step 4: Test Karo

Website kholo → corner mein chat icon dikhna chahiye → click karo → widget khule.

---

## ADMIN PANEL KAISE USE KAREIN

URL: `http://localhost:5000/admin` (ya production mein `https://...onrender.com/admin`)

Admin panel mein yeh sab kar sakte ho:

| Feature | Kya karta hai |
|---|---|
| **Upload File** | PDF/CSV/JSON/TXT upload karo → Pinecone mein store hota hai |
| **Clear Knowledge Base** | Pinecone ka saara data delete karo (careful!) |
| **Test Query** | Koi bhi sawal likhkar check karo ki AI kya answer dega |
| **Env Verify** | Check karo ki OpenAI, Pinecone, Magento connections sahi hain |

**Admin token kya hai?**
Yeh ek secret password hai (`ADMIN_API_KEY` env var se). Admin panel mein yeh daalna padta hai pehli baar. Value: `cc27f8289cc38...` (START.md mein poori value hai).

---

## INSTALL VIDEOS KAISE SETUP KAREIN

Yeh feature customer ko unke order ke products ke hisaab se installation videos dikhata hai.

### Step 1: CSV File Banao

```csv
category,url,title
plissegardiner,https://vimeo.com/123456789,Plissegardin Installation Guide
rullegardiner,https://vimeo.com/987654321,Rullegardin Installation Guide
general,https://vimeo.com/111111111,General Installation Guide
```

- `category` = product category ka naam (Magento category se match hona chahiye)
- `url` = Vimeo ya YouTube video link
- `title` = video ka naam jo widget mein dikhega
- `general` = agar koi category match na ho toh yeh video dikhega

### Step 2: Admin Panel Se Upload Karo

File ka naam hona chahiye: `install_videos.csv` ya `install_videos.txt`

Upload karo admin panel se → `server/data/installVideos.json` mein save ho jaata hai.

### Step 3: Test Karo

Widget mein "Installation Guides" click karo → email + order number daalo → videos dikhne chahiye.

---

## FAQS — Common Problems

**Q: Server start nahi ho raha?**
A: Check karo `server/.env` file hai ya nahi. `OPENAI_API_KEY` aur `PINECONE_API_KEY` set hain ya nahi.

**Q: Chat mein "I don't have information" aa raha hai?**
A: Knowledge base empty hai. Admin panel se pehle kuch files upload karo.

**Q: Order status nahi aa raha?**
A: `MAGENTO_BEARER_TOKEN` expire ho sakta hai. Magento Admin se naya token lo aur `.env` update karo.

**Q: Widget website pe nahi dikh raha?**
A: Browser console mein koi error hai? Usually React CDN load nahi hua hota ya `data-base-url` galat hai.

**Q: Admin panel mein "Unauthorized" aa raha hai?**
A: Admin token galat enter kiya. `START.md` mein token value dekho aur dobara enter karo (spaces remove karke).

**Q: Installation videos nahi aa rahe?**
A: Pehle `install_videos.csv` upload karna padega. Agar upload kiya hai lekin phir bhi nahi aa raha, toh Magento Catalog API 401 error aa sakta hai — category IDs nahi aa rahe. Is case mein `general` video aayega.

---

## ENVIRONMENT VARIABLES — Kya Kya Chahiye

| Variable | Kahan se milega | Kyun chahiye |
|---|---|---|
| `OPENAI_API_KEY` | platform.openai.com → API Keys | GPT-4o use karne ke liye |
| `PINECONE_API_KEY` | app.pinecone.io → API Keys | Knowledge base store/search ke liye |
| `PINECONE_INDEX_NAME` | Pinecone dashboard mein index ka naam | Konsa index use karna hai |
| `ADMIN_API_KEY` | Khud set karo (koi bhi random string) | Admin panel protect karne ke liye |
| `MAGENTO_BEARER_TOKEN` | Magento Admin → System → Integrations | Order data padhne ke liye |
| `MAGENTO_API_URL` | `https://yourstore.com/rest/V1` | Magento ka API address |
| `PORT` | Default 5000 (change kar sakte ho) | Server kis port pe chale |
| `MAX_FILE_SIZE_MB` | Default 10 (MB mein) | Upload size limit |

---

## RENDER PE DEPLOY KARNA (Production)

Render.com free hosting deta hai Node.js apps ke liye.

1. **GitHub push karo:**
   ```bash
   git add .
   git commit -m "changes"
   git push origin feature/widget-installation-guides
   ```

2. **Render automatically redeploy karta hai** (connected hai GitHub se)

3. **Environment variables Render pe bhi set karo:**
   - Render Dashboard → Service → Environment
   - Wahi sab variables daalo jo `server/.env` mein hain

4. **Production URL:** `https://ai-agent-hybrid.onrender.com`

---

## EK NAZAR MEIN — Poora System

```
CUSTOMER (Magento website pe)
     ↓ chat widget open kiya
     ↓
WIDGET (client/src/ - React)
     ↓ API call bheja
     ↓
SERVER (server/ - Node.js on Render.com)
     ↓
   3 cheezein hoti hain:
     ├── OPENAI GPT-4o  → question samjha, jawab banaya
     ├── PINECONE       → FAQ/product knowledge search ki
     └── MAGENTO API    → order data liya (sirf order related sawalon ke liye)
     ↓
WIDGET ko jawab wapas gaya → Customer ko dikha
```

---

## APNE PROJECT MEIN LAGANE KE LIYE (Other than Magento)

Kisi bhi website mein lagao — WordPress, plain HTML, Shopify, kuch bhi:

```html
<!-- Container div -->
<div id="visor-ai-widget"
     data-base-url="https://ai-agent-hybrid.onrender.com"
     data-admin="false"
     data-theme-color="#667eea"
     data-accent-color="#764ba2">
</div>

<!-- React CDN -->
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>

<!-- Widget -->
<script src="URL_TO_YOUR_WIDGET_BUNDLE_JS"></script>
```

**data attributes customize karo:**
- `data-base-url` → apne server ka URL
- `data-theme-color` → primary color (hex code)
- `data-accent-color` → accent color (hex code)
- `data-admin="true"` → admin mode (file upload wala panel dikhega)
- `data-token="your-admin-key"` → admin mode mein token

---

*Is file ko update karo jab bhi kuch naya seekho ya change karo.*
