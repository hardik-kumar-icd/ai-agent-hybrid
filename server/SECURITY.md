# Security & Authentication Module

## Overview

Phase 3 Security & Authentication module provides token-based authentication, session management, request validation, and secure logging for the AI Hybrid Agent backend.

## Features

### 1. Token-Based Authentication

Admin routes require authentication via `ADMIN_API_KEY` environment variable.

**Protected Routes:**
- `POST /api/ingest` - File ingestion endpoint (admin only)
- `POST /ingest` - Legacy file ingestion endpoint (admin only)

**Usage:**
```bash
# Set in .env file
ADMIN_API_KEY=your-secret-admin-key-here

# Make authenticated request
curl -X POST http://localhost:5000/api/ingest \
  -H "Authorization: Bearer your-secret-admin-key-here" \
  -F "file=@document.pdf"
```

**Error Response (401):**
```json
{
  "error": "Unauthorized: Invalid or missing token"
}
```

### 2. Session Memory Cache

Stores temporary user context (order_id, email) by conversationId for automatic reuse.

**Features:**
- In-memory Map-based storage
- Automatic cleanup of sessions older than 1 hour
- Session data persists across requests for the same conversationId

**Usage:**
```javascript
// In route handler
const sessionData = req.session.get(); // Get stored order_id and email
req.session.set({ order_id: '12345', email: 'user@example.com' }); // Store
req.session.update({ order_id: '12345' }); // Update specific fields
req.session.clear(); // Clear session
```

**Headers:**
```
X-Conversation-Id: unique-conversation-id
```

### 3. Request Validation

Centralized validation middleware for API requests.

**Validators:**
- `validateMessage` - Validates message field in /visor-chat requests
- `validateOrderLookup` - Validates order_id and email for order lookups
- `validateConversationId` - Validates conversationId if required

**Error Response (400):**
```json
{
  "error": "Message is required"
}
```

### 4. Security Logging

Masks sensitive information (emails, order IDs) in logs.

**Masking Examples:**
- Email: `user@example.com` → `u***@example.com`
- Order ID: `12345` → `***45`
- Order ID: `V-9901` → `V-***1`

**Usage:**
```javascript
const { logOrderLookup, logApiRequest } = require('./utils/securityLogger');

logOrderLookup(orderId, email, 'Order lookup');
logApiRequest(req, '/visor-chat');
```

### 5. Error Responses

Standardized error responses with appropriate HTTP status codes:

- **400** - Bad Request (validation errors)
- **401** - Unauthorized (authentication failures)
- **413** - Payload Too Large (file size exceeded)
- **429** - Too Many Requests (rate limiting)
- **500** - Internal Server Error (server errors)

## File Structure

```
server/
├── middlewares/
│   ├── auth.js          # Authentication middleware
│   ├── session.js       # Session management
│   └── validation.js    # Request validation
├── utils/
│   └── securityLogger.js # Secure logging utilities
└── routes/
    ├── fileRoute.js     # Updated with admin auth
    └── visorRoute.js    # Updated with validation & session
```

## Environment Variables

```env
# Required for admin routes
ADMIN_API_KEY=your-secret-admin-key-here

# Optional: File size limit (default: 10MB)
MAX_FILE_SIZE_MB=20
```

## Integration Examples

### Protected File Upload
```bash
curl -X POST http://localhost:5000/api/ingest \
  -H "Authorization: Bearer your-admin-key" \
  -F "file=@document.pdf"
```

### Chat with Session
```bash
curl -X POST http://localhost:5000/visor-chat \
  -H "Content-Type: application/json" \
  -H "X-Conversation-Id: conv-123" \
  -d '{
    "message": "What is the status of my order?",
    "order_id": "12345",
    "email": "user@example.com"
  }'
```

### Subsequent Request (uses session)
```bash
curl -X POST http://localhost:5000/visor-chat \
  -H "Content-Type: application/json" \
  -H "X-Conversation-Id: conv-123" \
  -d '{
    "message": "When will it be delivered?"
  }'
# order_id and email are automatically retrieved from session
```

## Security Best Practices

1. **Always set ADMIN_API_KEY** in production
2. **Use HTTPS** in production to protect tokens
3. **Rotate ADMIN_API_KEY** periodically
4. **Monitor logs** for suspicious activity
5. **Set appropriate file size limits** via MAX_FILE_SIZE_MB
6. **Use unique conversationIds** for each user session

## Compatibility

- ✅ Fully compatible with existing RAG and chat logic
- ✅ Non-breaking changes to existing routes
- ✅ Backward compatible with existing clients
- ✅ Graceful degradation if ADMIN_API_KEY not set (with warning)
