const express = require('express');
const router = express.Router();
const { processVisorMessage } = require('../agents/visorAgent');
const { validateMessage } = require('../middlewares/validation');
const { sessionMiddleware } = require('../middlewares/session');
const { logApiRequest, logOrderLookup, maskEmail, maskOrderId } = require('../utils/securityLogger');

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

// Helper function to extract order_id from message text
function extractOrderIdFromMessage(message) {
  if (!message || typeof message !== 'string') return null;
  
  // Patterns: "order #90948", "#90948", "order 90948", "ordre 90948", "order_id: 90948", just "90948"
  const patterns = [
    /order\s*#?\s*(\d+)/i,
    /ordre\s*#?\s*(\d+)/i,
    /#(\d+)/,
    /order_id\s*:\s*(\d+)/i,
    /order\s+(\d+)/i,
    /ordre\s+(\d+)/i,
    /\b(\d{4,})\b/ // Standalone 4+ digit number (likely order ID)
  ];
  
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  return null;
}

// Helper function to extract email from message text
function extractEmailFromMessage(message) {
  if (!message || typeof message !== 'string') return null;
  
  // Email regex pattern
  const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
  const match = message.match(emailPattern);
  
  return match ? match[0] : null;
}

// POST /visor-chat endpoint
router.post('/', sessionMiddleware, validateMessage, async (req, res) => {
  try {
    const { message, email, order_id } = req.body;

    // Log API request with masked sensitive data
    logApiRequest(req, '/visor-chat');

    // Extract order_id and email from message text if not in body
    const extractedOrderId = extractOrderIdFromMessage(message);
    const extractedEmail = extractEmailFromMessage(message);

    // Get session data if available
    const sessionData = req.session.get();
    const conversationId = req.conversationId;
    
    // Debug logging: Show what we're extracting and retrieving (with masking for security)
    console.log(`[Session Debug] ConversationId: ${conversationId || 'none'}`);
    console.log(`[Session Debug] From body - order_id: ${order_id ? maskOrderId(order_id) : 'none'}, email: ${email ? maskEmail(email) : 'none'}`);
    console.log(`[Session Debug] Extracted from message - order_id: ${extractedOrderId ? maskOrderId(extractedOrderId) : 'none'}, email: ${extractedEmail ? maskEmail(extractedEmail) : 'none'}`);
    console.log(`[Session Debug] From session - order_id: ${sessionData?.order_id ? maskOrderId(sessionData.order_id) : 'none'}, email: ${sessionData?.email ? maskEmail(sessionData.email) : 'none'}`);
    
    // Priority: body > extracted from message > session data
    const finalOrderId = order_id || extractedOrderId || sessionData?.order_id || null;
    const finalEmail = email || extractedEmail || sessionData?.email || null;

    // Update session if we have new order_id or email (from any source)
    if (finalOrderId || finalEmail) {
      req.session.update({
        order_id: finalOrderId || undefined,
        email: finalEmail || undefined
      });
      console.log(`[Session Debug] ✅ Stored in session - order_id: ${finalOrderId ? maskOrderId(finalOrderId) : 'none'}, email: ${finalEmail ? maskEmail(finalEmail) : 'none'}`);
    } else {
      console.log(`[Session Debug] No new data to store`);
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

    // Get conversation history for follow-up context (e.g. "this product")
    const history = req.session.getHistory ? req.session.getHistory() : [];

    // Process message through Visor agent with history
    const reply = await processVisorMessage(enhancedMessage, history);

    // Append this turn to session history so next message has context
    if (req.session.appendToHistory) {
      req.session.appendToHistory('user', enhancedMessage);
      req.session.appendToHistory('assistant', reply);
    }

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
