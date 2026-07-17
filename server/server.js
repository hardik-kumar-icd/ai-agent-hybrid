const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

// Safety net for the recurring "production traffic accidentally hit the
// staging store" incident: if we're running in production, refuse to boot
// if any store URL still points at a test/staging domain. A misconfigured
// .env should fail loudly at startup, not silently misroute live customer
// order lookups.
if (process.env.NODE_ENV === 'production') {
  const storeUrlVars = ['MAGENTO_API_URL', 'MAGENTO_STORE_BASE_URL', 'WORDPRESS_API_URL'];
  const offending = storeUrlVars.filter((name) => (process.env[name] || '').includes('test.'));
  if (offending.length > 0) {
    console.error(
      `FATAL: NODE_ENV=production but the following env vars point at a test/staging domain: ${offending.join(', ')}. ` +
      'Refusing to start to avoid misrouting live traffic. Fix server/.env before restarting.'
    );
    process.exit(1);
  }
}

// Import routes
const chatRoute = require('./routes/chatRoute');
const fileRoute = require('./routes/fileRoute');
const visorRoute = require('./routes/visorRoute');
const visorChatStreamRoute = require('./routes/visorChatStreamRoute');
const envVerifyRoute = require('./routes/envVerifyRoute');
const orderInstallGuidesRoute = require('./routes/orderInstallGuidesRoute');
const feedbackRoute = require('./routes/feedbackRoute');
const adminRoute = require('./routes/adminRoute');
const { ragAgent } = require('./agents/ragAgent');
const { deleteAllVectors } = require('./utils/embeddingService');

// Import rate limiters
const { globalLimiter, ingestLimiter, chatLimiter } = require('./middlewares/rateLimiter');

// Import session cache and auth for debug endpoints
const { sessionCache } = require('./middlewares/session');
const { requireAdminAuth } = require('./middlewares/auth');

const app = express();
const PORT = process.env.PORT || 5000;

// Trust proxy for Render.com and other reverse proxies
// Set to 1 to trust only the first proxy (Render.com uses one proxy layer)
// This is more secure than 'true' which trusts all proxies
app.set('trust proxy', 1);

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

// File size limit from environment variable (default: 10MB)
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10) * 1024 * 1024;

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

// CORS configuration
// The agent is only meant to be embedded on the real Visor storefronts.
// Origins are locked to that allow-list in production; localhost/ngrok are
// only permitted outside of production for local development.
const PRODUCTION_ALLOWED_ORIGINS = [
  'https://visor.no',
  'https://test.visor.no',
  // The admin dashboard is served from this same host at /admin. Vite's
  // production build emits <script type="module" crossorigin> and
  // <link crossorigin> tags by default, which makes the browser send an
  // Origin header even for same-origin static assets — without this entry
  // the admin panel's own JS/CSS get rejected by this same CORS policy.
  'https://agent.visor.no'
];

function isDevOrigin(origin) {
  return origin.includes('ngrok') || origin.includes('localhost') || origin.includes('127.0.0.1');
}

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, curl, same-origin, server-to-server)
    if (!origin) return callback(null, true);

    const isAllowed = PRODUCTION_ALLOWED_ORIGINS.includes(origin) ||
      (process.env.NODE_ENV !== 'production' && isDevOrigin(origin));

    if (isAllowed) {
      callback(null, true);
    } else {
      const err = new Error('Not allowed by CORS');
      err.status = 403;
      callback(err);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Conversation-Id'],
  exposedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

// Origin/Referer guard for the expensive chat/RAG endpoints.
// Defense-in-depth on top of CORS: CORS only constrains browsers, so a
// scripted client (curl, a bot, a widget embedded on some other site) can
// ignore it entirely. This rejects any request whose Origin/Referer header
// (when present) doesn't point at a real Visor storefront. It does not stop
// an attacker who forges these headers directly, but it stops casual
// scraping/hijacking/third-party embedding, which is the realistic threat.
function originGuard(req, res, next) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const isDev = process.env.NODE_ENV !== 'production';

  const matches = (value) => {
    if (!value) return true; // header absent — nothing to check here
    if (PRODUCTION_ALLOWED_ORIGINS.some((allowed) => value.startsWith(allowed))) return true;
    return isDev && isDevOrigin(value);
  };

  if (matches(origin) && matches(referer)) {
    return next();
  }

  return res.status(403).json({ error: 'Forbidden: request not allowed from this origin' });
}

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply global rate limiter (60 requests per minute per IP)
app.use(globalLimiter);

// Basic route
app.get('/', (req, res) => {
  res.json({ message: 'Server is running!' });
});

// Chat route
app.use('/chat', originGuard, chatLimiter, chatRoute);

// File ingestion route (RAG) - Legacy endpoint
app.use('/ingest', fileRoute);

// File ingestion route (RAG) - Admin API endpoint with rate limiting (10 requests per minute)
app.use('/api/ingest', ingestLimiter, fileRoute);

// Visor.no AI Agent route
app.use('/visor-chat', originGuard, chatLimiter, visorRoute);
app.use('/visor-chat/stream', originGuard, chatLimiter, visorChatStreamRoute);

// Customer: order-based installation videos for purchased categories
app.use('/api/order', orderInstallGuidesRoute);
app.use('/api/feedback', feedbackRoute);
app.use('/api/admin', adminRoute);

// Environment verification endpoint (admin only)
app.use('/api/verify-env', requireAdminAuth, envVerifyRoute);

// Admin endpoint to clear all Pinecone vectors (admin only)
// WARNING: This permanently deletes ALL data from Pinecone
// Supports DELETE, GET, and POST methods for flexibility
// Optional query parameter: ?namespace=name to clear specific namespace
const handleClearPinecone = async (req, res) => {
  try {
    // Get namespace from query params or body
    const namespace = req.query.namespace || req.body?.namespace || '';
    
    const result = await deleteAllVectors(namespace);
    res.json({
      success: true,
      message: result.message,
      warning: namespace 
        ? `All vectors have been deleted from namespace '${namespace}'. You can now upload fresh data.`
        : 'All vectors have been deleted from Pinecone. You can now upload fresh data.',
      namespace: namespace || 'default'
    });
  } catch (error) {
    console.error('Error clearing Pinecone:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear Pinecone vectors',
      message: error.message
    });
  }
};

app.delete('/api/pinecone/clear', requireAdminAuth, handleClearPinecone);
app.get('/api/pinecone/clear', requireAdminAuth, handleClearPinecone);
app.post('/api/pinecone/clear', requireAdminAuth, handleClearPinecone);

// Admin endpoint to check what's in Pinecone (debug)
app.get('/api/pinecone/debug', requireAdminAuth, async (req, res) => {
  try {
    const { initializePinecone } = require('./utils/embeddingService');
    const index = await initializePinecone();
    
    // Query with a dummy vector to see what's stored
    const dummyVector = new Array(3072).fill(0);
    const queryResponse = await index.query({
      vector: dummyVector,
      topK: 10,
      includeMetadata: true,
    });
    
    const results = queryResponse.matches.map(match => ({
      id: match.id,
      score: match.score,
      source: match.metadata?.source || 'unknown',
      uploadTimestamp: match.metadata?.upload_timestamp || 0,
      textPreview: (match.metadata?.text || '').substring(0, 100),
    }));
    
    res.json({
      totalFound: queryResponse.matches.length,
      results: results,
      message: queryResponse.matches.length === 0 
        ? 'Pinecone index is empty. Upload files to add data.'
        : `Found ${queryResponse.matches.length} vectors in Pinecone.`
    });
  } catch (error) {
    console.error('Error checking Pinecone:', error);
    res.status(500).json({
      error: 'Failed to check Pinecone',
      message: error.message
    });
  }
});

// Admin endpoint to test semantic search with actual query
app.get('/api/pinecone/test-search', requireAdminAuth, async (req, res) => {
  try {
    const { searchSimilar } = require('./utils/embeddingService');
    const query = req.query.q || 'What products do you have?';
    
    console.log(`[Test Search] Testing query: "${query}"`);
    const results = await searchSimilar(query, 5);
    
    res.json({
      query: query,
      resultsFound: results.length,
      results: results.map((r, idx) => ({
        rank: idx + 1,
        score: r.score,
        source: r.source,
        textPreview: r.text.substring(0, 200),
        fullText: r.text
      })),
      message: results.length === 0 
        ? 'No results found for this query. Try a different search term.'
        : `Found ${results.length} results for "${query}"`
    });
  } catch (error) {
    console.error('Error testing search:', error);
    res.status(500).json({
      error: 'Failed to test search',
      message: error.message
    });
  }
});

// Debug endpoint to inspect active sessions (admin only)
app.get('/api/sessions', requireAdminAuth, (req, res) => {
  try {
    const { maskEmail, maskOrderId } = require('./utils/securityLogger');
    const sessions = sessionCache.getAll();
    
    // Mask sensitive data for display
    const maskedSessions = {};
    for (const [id, session] of Object.entries(sessions)) {
      maskedSessions[id] = {
        order_id: session.order_id ? maskOrderId(session.order_id) : null,
        email: session.email ? maskEmail(session.email) : null,
        lastAccessed: session.lastAccessed
      };
    }
    
    res.json({
      activeSessions: Object.keys(sessions).length,
      sessions: maskedSessions,
      note: 'Sensitive data is masked for security. Check server logs for full details.'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to retrieve sessions',
      message: error.message
    });
  }
});

// RAG route for testing - GET handler (with query parameter)
app.get('/rag', originGuard, chatLimiter, async (req, res) => {
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
app.post('/rag', originGuard, chatLimiter, async (req, res) => {
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
  const maxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10);
  res.json({
    message: 'Upload endpoint - Use POST method',
    method: 'POST',
    endpoint: '/upload',
    contentType: 'multipart/form-data',
    fieldName: 'file',
    maxFileSize: `${maxFileSizeMB}MB`,
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

// Serve the admin dashboard SPA from /admin
// The Vite admin build outputs to server/public/admin
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// Optional SPA fallback for client-side routing under /admin
// app.get('/admin/*', (req, res) => {
//   res.sendFile(path.join(__dirname, 'public/admin/index.html'));
// });

// Error-handling middleware for Multer errors (must be after all routes)
app.use((error, req, res, next) => {
  // Handle Multer errors
  if (error instanceof multer.MulterError) {
    let statusCode = 400;
    let message = 'File upload error';
    let details = {};

    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        const maxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10);
        statusCode = 413; // Payload Too Large
        message = `File size exceeds the maximum allowed size of ${maxFileSizeMB}MB`;
        details = {
          code: error.code,
          maxFileSize: `${maxFileSizeMB}MB`,
          maxFileSizeBytes: MAX_FILE_SIZE
        };
        break;
      case 'LIMIT_FILE_COUNT':
        statusCode = 400;
        message = 'Too many files uploaded';
        details = { code: error.code };
        break;
      case 'LIMIT_FIELD_KEY':
        statusCode = 400;
        message = 'Field name too long';
        details = { code: error.code };
        break;
      case 'LIMIT_FIELD_VALUE':
        statusCode = 400;
        message = 'Field value too long';
        details = { code: error.code };
        break;
      case 'LIMIT_FIELD_COUNT':
        statusCode = 400;
        message = 'Too many fields';
        details = { code: error.code };
        break;
      case 'LIMIT_PART_COUNT':
        statusCode = 400;
        message = 'Too many parts';
        details = { code: error.code };
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        statusCode = 400;
        message = 'Unexpected file field';
        details = { code: error.code, field: error.field };
        break;
      case 'MISSING_FIELD_NAME':
        statusCode = 400;
        message = 'Missing field name';
        details = { code: error.code };
        break;
      default:
        statusCode = 400;
        message = 'File upload error';
        details = { code: error.code || 'UNKNOWN' };
    }

    return res.status(statusCode).json({
      error: 'File upload failed',
      message: message,
      details: details
    });
  }

  // Handle other errors
  if (error) {
    console.error('Unhandled error:', error);
    return res.status(error.status || 500).json({
      error: 'Internal server error',
      message: error.message || 'An unexpected error occurred'
    });
  }

  // Pass to next error handler if not handled
  next(error);
});

// Graceful shutdown handler
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  sessionCache.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  sessionCache.destroy();
  process.exit(0);
});

// Start server
const server = app.listen(PORT, () => {
  const maxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10);
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Max file size limit: ${maxFileSizeMB}MB`);
  console.log('Rate limiter active (global: 60/min, ingest: 10/min)');
  if (process.env.ADMIN_API_KEY) {
    console.log('Admin authentication enabled');
  } else {
    console.warn('WARNING: ADMIN_API_KEY not set - admin routes are unprotected');
  }
});

module.exports = server;
