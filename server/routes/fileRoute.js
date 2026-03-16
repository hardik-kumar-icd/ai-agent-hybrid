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
