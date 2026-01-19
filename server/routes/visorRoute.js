const express = require('express');
const router = express.Router();
const { processVisorMessage } = require('../agents/visorAgent');
const { validateMessage } = require('../middlewares/validation');
const { sessionMiddleware } = require('../middlewares/session');
const { logApiRequest, logOrderLookup } = require('../utils/securityLogger');

// GET handler for endpoint info
router.get('/', (req, res) => {
  res.json({
    message: 'Visor.no AI Agent endpoint - Use POST method',
    method: 'POST',
    endpoint: '/visor-chat',
    body: {
      message: 'string (required) - Your question or message in Norwegian or English',
      email: 'string (optional) - Customer email for order lookup',
      order_id: 'string (optional) - Order ID for order lookup'
    },
    examples: {
      simple: {
        curl: 'curl -X POST http://localhost:5000/visor-chat -H "Content-Type: application/json" -d \'{"message":"What is the status of order 5501?"}\''
      },
      withEmail: {
        curl: 'curl -X POST http://localhost:5000/visor-chat -H "Content-Type: application/json" -d \'{"message":"What is the status of order 5501?","email":"user@example.com","order_id":"5501"}\''
      }
    }
  });
});

// POST /visor-chat endpoint
router.post('/', sessionMiddleware, validateMessage, async (req, res) => {
  try {
    const { message, email, order_id } = req.body;

    // Log API request with masked sensitive data
    logApiRequest(req, '/visor-chat');

    // Get session data if available
    const sessionData = req.session.get();
    
    // Use provided values or fall back to session data
    const finalOrderId = order_id || sessionData?.order_id || null;
    const finalEmail = email || sessionData?.email || null;

    // Update session if new order_id or email provided
    if (order_id || email) {
      req.session.update({
        order_id: order_id || undefined,
        email: email || undefined
      });
    }

    // Log order lookup if order_id and email are present
    if (finalOrderId && finalEmail) {
      logOrderLookup(finalOrderId, finalEmail, '[Visor Route] Order lookup');
    }

    // Build enhanced message with context if email/order_id available
    let enhancedMessage = message;
    if (finalOrderId || finalEmail) {
      const context = [];
      if (finalOrderId) context.push(`Order ID: ${finalOrderId}`);
      if (finalEmail) context.push(`Email: ${finalEmail}`);
      enhancedMessage = `${message}\n\n[Context: ${context.join(', ')}]`;
    }

    // Process message through Visor agent
    const reply = await processVisorMessage(enhancedMessage);

    // Return response
    res.json({
      reply: reply
    });
  } catch (error) {
    console.error('Visor chat route error:', error);
    
    // Return appropriate error status
    const statusCode = error.message.includes('API key') ? 401 :
                      error.message.includes('rate limit') ? 429 :
                      error.message.includes('timeout') ? 504 : 500;

    res.status(statusCode).json({ 
      error: 'Visor chat error',
      message: error.message 
    });
  }
});

module.exports = router;
