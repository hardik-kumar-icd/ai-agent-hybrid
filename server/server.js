const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

// Import routes
const chatRoute = require('./routes/chatRoute');
const fileRoute = require('./routes/fileRoute');
const { ragAgent } = require('./agents/ragAgent');

const app = express();
const PORT = process.env.PORT || 5000;

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Make sure this directory exists
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic route
app.get('/', (req, res) => {
  res.json({ message: 'Server is running!' });
});

// Chat route
app.use('/chat', chatRoute);

// File ingestion route (RAG)
app.use('/ingest', fileRoute);

// RAG route for testing - GET handler (with query parameter)
app.get('/rag', async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query) {
      return res.status(400).json({
        error: 'Query parameter is required',
        example: 'GET /rag?query=your question here',
        or: 'POST /rag with JSON body: { "query": "your question here" }'
      });
    }

    const response = await ragAgent(query);
    
    res.json({
      query: query,
      response: response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('RAG route error:', error);
    res.status(500).json({
      error: 'RAG query failed',
      message: error.message
    });
  }
});

// RAG route - POST handler (with JSON body)
app.post('/rag', async (req, res) => {
  try {
    // Accept both 'query' and 'message' fields for flexibility
    const query = req.body.query || req.body.message;
    
    if (!query) {
      return res.status(400).json({
        error: 'Query or message is required in request body',
        example: {
          method: 'POST',
          url: '/rag',
          body: {
            query: 'your question here'
          },
          or: {
            message: 'your question here'
          }
        }
      });
    }

    const response = await ragAgent(query);
    
    res.json({
      query: query,
      response: response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('RAG route error:', error);
    res.status(500).json({
      error: 'RAG query failed',
      message: error.message
    });
  }
});

// Upload route - GET handler for info
app.get('/upload', (req, res) => {
  res.json({
    message: 'Upload endpoint - Use POST method',
    method: 'POST',
    endpoint: '/upload',
    contentType: 'multipart/form-data',
    fieldName: 'file',
    maxFileSize: '10MB',
    example: {
      curl: 'curl -X POST http://localhost:5000/upload -F "file=@yourfile.txt"'
    }
  });
});

// Upload route - POST handler
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No file uploaded' 
      });
    }

    const fileInfo = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      uploadedAt: new Date().toISOString()
    };

    res.json({
      message: 'File uploaded successfully',
      file: fileInfo
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
