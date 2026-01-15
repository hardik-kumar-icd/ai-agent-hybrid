const express = require('express');
const router = express.Router();
const { processVisorMessage } = require('../agents/visorAgent');

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
router.post('/', async (req, res) => {
  try {
    const { message, email, order_id } = req.body;

    // Validate required fields
    if (!message) {
      return res.status(400).json({ 
        error: 'Message is required',
        example: {
          message: 'What is the status of order 5501?',
          email: 'user@example.com',  // Optional: can be provided here or in message
          order_id: '5501'  // Optional: can be provided here or in message
        }
      });
    }

    // Build enhanced message with context if email/order_id provided
    let enhancedMessage = message;
    if (email || order_id) {
      const context = [];
      if (order_id) context.push(`Order ID: ${order_id}`);
      if (email) context.push(`Email: ${email}`);
      enhancedMessage = `${message}\n\n[Context: ${context.join(', ')}]`;
    }

    // Process message through Visor agent
    console.log(`[Visor Route] Processing message:`, { message, email, order_id });
    const reply = await processVisorMessage(enhancedMessage);
    console.log(`[Visor Route] Response generated successfully`);

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
