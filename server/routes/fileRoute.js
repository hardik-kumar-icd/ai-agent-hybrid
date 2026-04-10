const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractText } = require('../utils/fileParser');
const { splitText } = require('../utils/textSplitter');
const { embedAndStore } = require('../utils/embeddingService');
const { requireAdminAuth } = require('../middlewares/auth');
const { logApiRequest } = require('../utils/securityLogger');
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 50);

function normalizeCategoryKey(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_:-]/g, '');
}

function parseLooseDelimited(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) return [];

  const extractLooseLine = (line) => {
    const urlMatch = line.match(/https?:\/\/[^\s<>"')]+/i);
    if (!urlMatch) return null;
    const url = urlMatch[0].trim();
    const before = line.slice(0, urlMatch.index).trim();
    const after = line.slice(urlMatch.index + url.length).trim();

    // Try to interpret "category - title URL" or "category URL title"
    // We'll treat the first part as category and the remainder (after url) as title when present.
    const category = before.replace(/[-–—:]+$/g, '').trim();
    const title = after.replace(/^[-–—:]+/g, '').trim();
    if (!category) return null;
    return { category, url, title };
  };

  const delimiter = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';

  const splitRow = (row) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') {
        // Toggle quote state unless it's an escaped quote
        if (inQuotes && row[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (!inQuotes && ch === delimiter) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const header = splitRow(lines[0]).map((h) => normalizeCategoryKey(h));
  const hasHeader = header.includes('category') || header.includes('category_id') || header.includes('video_url') || header.includes('url');

  const rows = [];
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    if (!cols.some(Boolean)) {
      const loose = extractLooseLine(lines[i]);
      if (loose) rows.push(loose);
      continue;
    }
    if (hasHeader) {
      const obj = {};
      for (let c = 0; c < header.length; c++) obj[header[c]] = cols[c];
      rows.push(obj);
    } else {
      // No header: try to interpret:
      // - "category, url, title"
      // - "category; url; title"
      // - "category url title" (loose)
      if (cols.length >= 2 && cols[0] && cols[1]) {
        rows.push({ category: cols[0], url: cols[1], title: cols[2] });
      } else {
        const loose = extractLooseLine(lines[i]);
        if (loose) rows.push(loose);
      }
    }
  }
  return rows;
}

function parseCategoryUrlBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  let currentCategory = null;
  for (const line of lines) {
    const t = String(line || '').trim();
    if (!t) continue;
    const urlMatch = t.match(/https?:\/\/[^\s<>"')]+/i);
    if (urlMatch) {
      if (currentCategory) {
        rows.push({ category: currentCategory, url: urlMatch[0].trim(), title: '' });
      }
    } else {
      // treat as category header
      currentCategory = t;
    }
  }
  return rows;
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    // Accept PDF, text, JSON, and office files
    const allowedTypes = ['.pdf', '.txt', '.text', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.json'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, text, docx, doc, xlsx, xls, csv, and json files are allowed.'));
    }
  }
});

// GET handler for endpoint info
router.get('/', (req, res) => {
  res.json({
    message: 'File ingestion endpoint - Use POST method',
    method: 'POST',
    endpoint: '/ingest',
    contentType: 'multipart/form-data',
    fieldName: 'file',
    acceptedTypes: ['PDF', 'TXT', 'DOCX', 'DOC', 'XLSX', 'XLS', 'CSV', 'JSON'],
    maxFileSize: '10MB',
    example: {
      curl: 'curl -X POST http://localhost:5000/ingest -F "file=@document.pdf"'
    }
  });
});

// POST /ingest endpoint - Admin only
router.post('/', requireAdminAuth, upload.single('file'), async (req, res) => {
  let filePath = null;
  
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No file uploaded' 
      });
    }

    filePath = req.file.path;
    const sourceName = req.file.originalname || path.basename(filePath);

    // Special ingestion: single mapping file for category -> install video URL(s)
    // Filename convention: install_videos.csv / install_videos.txt
    if (/^install_videos\.(csv|txt|text)$/i.test(sourceName)) {
      // IMPORTANT: for mapping files we must preserve newlines.
      // extractText() normalizes whitespace (including newlines) which breaks "Category line + URL lines" formats.
      const raw = fs.readFileSync(filePath, 'utf-8');
      let rows = parseLooseDelimited(raw);
      // Support ultra-loose "Category line + URL lines" format
      if (!rows || rows.length === 0) {
        rows = parseCategoryUrlBlocks(raw);
      }

      const byCategoryId = {};
      const byCategoryKey = {};
      let general = null;

      for (const r of rows) {
        const url = (r.video_url || r.url || r.link || '').trim();
        const title = (r.title || r.label || '').trim();
        const categoryIdRaw = (r.category_id || r.categoryid || '').toString().trim();
        const categoryRaw = (r.category || r.category_key || r.categorykey || '').toString().trim();

        if (!url) continue;

        // General fallback row
        if (normalizeCategoryKey(categoryRaw) === 'general' || normalizeCategoryKey(categoryIdRaw) === 'general') {
          general = { url, title: title || 'General installation video' };
          continue;
        }

        if (categoryIdRaw && /^\d+$/.test(categoryIdRaw)) {
          byCategoryId[String(Number(categoryIdRaw))] = { url, title: title || `Category ${categoryIdRaw}` };
        } else if (categoryRaw) {
          byCategoryKey[normalizeCategoryKey(categoryRaw)] = { url, title: title || categoryRaw };
        }
      }

      const dataDir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const mappingPath = path.join(dataDir, 'installVideos.json');
      fs.writeFileSync(mappingPath, JSON.stringify({ general, byCategoryId, byCategoryKey }, null, 2), 'utf-8');

      return res.json({
        message: 'Install video mapping saved',
        mappingFile: 'server/data/installVideos.json',
        counts: {
          byCategoryId: Object.keys(byCategoryId).length,
          byCategoryKey: Object.keys(byCategoryKey).length,
          hasGeneral: Boolean(general?.url),
        },
      });
    }

    // Backwards-compatible alias: allow install_guides.txt to act as the install video mapping
    // (Admins sometimes reuse the old name; accept it to prevent silent misconfiguration.)
    if (/^install_guides\.(txt|text|csv)$/i.test(sourceName)) {
      // Preserve newlines for block format
      const raw = fs.readFileSync(filePath, 'utf-8');

      const rows = parseCategoryUrlBlocks(raw);

      const byCategoryId = {};
      const byCategoryKey = {};
      let general = null;

      for (const r of rows) {
        const url = (r.video_url || r.url || r.link || '').trim();
        const title = (r.title || r.label || '').trim();
        const categoryRaw = (r.category || r.category_key || r.categorykey || '').toString().trim();
        if (!url || !categoryRaw) continue;

        if (normalizeCategoryKey(categoryRaw) === 'general') {
          // keep the first general we encounter
          if (!general) general = { url, title: title || 'General installation video' };
          continue;
        }

        const key = normalizeCategoryKey(categoryRaw);
        if (key) byCategoryKey[key] = { url, title: title || categoryRaw };
      }

      const dataDir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const mappingPath = path.join(dataDir, 'installVideos.json');
      fs.writeFileSync(mappingPath, JSON.stringify({ general, byCategoryId, byCategoryKey }, null, 2), 'utf-8');

      return res.json({
        message: 'Install video mapping saved (from install_guides.* alias)',
        mappingFile: 'server/data/installVideos.json',
        counts: {
          byCategoryId: 0,
          byCategoryKey: Object.keys(byCategoryKey).length,
          hasGeneral: Boolean(general?.url),
        },
      });
    }

    // Step 1: Parse the file and extract text
    console.log(`Extracting text from ${sourceName}...`);
    const text = await extractText(filePath);

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ 
        error: 'No text content found in the file' 
      });
    }

    // Step 2: Split text into chunks
    console.log(`Splitting text into chunks...`);
    const chunks = await splitText(text);
    
    if (!chunks || chunks.length === 0) {
      return res.status(400).json({ 
        error: 'Failed to split text into chunks' 
      });
    }

    // Step 3: Create embeddings and store in Pinecone
    console.log(`Creating embeddings and storing in Pinecone...`);
    await embedAndStore(chunks, sourceName);

    // Step 4: Clean up uploaded file (optional - you might want to keep it)
    // fs.unlinkSync(filePath);

    // Return success response
    res.json({
      message: 'File processed and embedded successfully',
      chunksCount: chunks.length,
      sourceName: sourceName,
      fileSize: req.file.size
    });

  } catch (error) {
    console.error('File ingestion error:', error);
    
    // Clean up file on error
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Return appropriate error status
    const statusCode = error.message.includes('API key') ? 401 :
                      error.message.includes('PINECONE') ? 500 :
                      error.message.includes('Invalid file') ? 400 : 500;

    res.status(statusCode).json({ 
      error: 'File ingestion failed',
      message: error.message 
    });
  }
});

module.exports = router;
