/**
 * Request Validation Middleware
 * Centralized validation for API requests
 */

// Generous cap for a chat message — real customer messages rarely exceed a
// few hundred characters; this just bounds worst-case LLM token cost/DoS
// from a single oversized request, not normal usage.
const MAX_MESSAGE_LENGTH = 4000;

// The widget generates ids like 'conv-<timestamp>-<9 random base36 chars>'
// (client/src/components/ChatWidget.jsx) — not a UUID, so this only bounds
// length/charset rather than enforcing a specific format.
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Validate message field in request body
 */
function validateMessage(req, res, next) {
  const message = req.body?.message || req.query?.message;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({
      error: 'Message is required'
    });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`
    });
  }

  const conversationId = req.headers['x-conversation-id'] ||
                        req.body?.conversationId ||
                        req.query?.conversationId;

  if (conversationId !== undefined && conversationId !== null && conversationId !== '') {
    if (typeof conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(conversationId)) {
      return res.status(400).json({
        error: 'Invalid conversationId format'
      });
    }
  }

  next();
}

/**
 * Validate order_id and email for order lookup requests
 * Can use session data if available
 */
function validateOrderLookup(req, res, next) {
  // Try to get from request body, query params, or session
  const order_id = req.body?.order_id || 
                   req.query?.order_id || 
                   req.session?.get()?.order_id ||
                   null;
  
  const email = req.body?.email || 
                req.query?.email || 
                req.session?.get()?.email ||
                null;

  // Validate order_id
  if (!order_id || typeof order_id !== 'string' || order_id.trim().length === 0) {
    return res.status(400).json({
      error: 'order_id is required'
    });
  }

  // Validate email format
  if (!email || typeof email !== 'string' || email.trim().length === 0) {
    return res.status(400).json({
      error: 'email is required'
    });
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({
      error: 'Invalid email format'
    });
  }

  // Attach validated values to request for use in route handlers
  req.validatedOrderId = order_id.trim();
  req.validatedEmail = email.trim().toLowerCase();

  next();
}

/**
 * Validate conversationId if required
 */
function validateConversationId(req, res, next) {
  const conversationId = req.headers['x-conversation-id'] || 
                        req.body?.conversationId || 
                        req.query?.conversationId;

  if (!conversationId || typeof conversationId !== 'string' || conversationId.trim().length === 0) {
    return res.status(400).json({
      error: 'conversationId is required'
    });
  }

  next();
}

module.exports = {
  validateMessage,
  validateOrderLookup,
  validateConversationId
};
