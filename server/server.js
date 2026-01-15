const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

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

// Chat route - GET handler for info
app.get('/chat', (req, res) => {
  res.json({
    message: 'Chat endpoint - Use POST method',
    method: 'POST',
    endpoint: '/chat',
    body: {
      message: 'string (required)',
      conversationId: 'string (optional)'
    },
    example: {
      curl: 'curl -X POST http://localhost:5000/chat -H "Content-Type: application/json" -d \'{"message":"Hello"}\''
    }
  });
});

// Chat route - POST handler
app.post('/chat', (req, res) => {
  try {
    const { message, conversationId } = req.body;

    if (!message) {
      return res.status(400).json({ 
        error: 'Message is required' 
      });
    }

    // Basic chat response (you can extend this with AI logic)
    const response = {
      id: Date.now().toString(),
      message: `Echo: ${message}`,
      conversationId: conversationId || null,
      timestamp: new Date().toISOString()
    };

    res.json(response);
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
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
