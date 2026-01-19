/**
 * Request Validation Middleware
 * Centralized validation for API requests
 */

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
