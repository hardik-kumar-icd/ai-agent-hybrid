const express = require('express');
const router = express.Router();
const { chatAgent } = require('../agents/chatAgent');

// GET handler for endpoint info
router.get('/', (req, res) => {
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

// POST /chat endpoint
router.post('/', async (req, res) => {
  try {
    const { message, conversationId } = req.body;

    // Validate required fields
    if (!message) {
      return res.status(400).json({ 
        error: 'Message is required' 
      });
    }

    // Call the chat agent
    const aiReply = await chatAgent(message, conversationId);

    // Send back the response
    const response = {
      id: Date.now().toString(),
      message: aiReply,
      conversationId: conversationId || null,
      timestamp: new Date().toISOString()
    };

    res.json(response);
  } catch (error) {
    console.error('Chat route error:', error);
    
    // Return appropriate error status
    const statusCode = error.message.includes('API key') || 
                      error.message.includes('authentication') ? 401 :
                      error.message.includes('rate limit') || 
                      error.message.includes('quota') ? 429 :
                      error.message.includes('timeout') ? 504 : 500;

    res.status(statusCode).json({ 
      error: 'Chat error',
      message: error.message 
    });
  }
});

module.exports = router;
