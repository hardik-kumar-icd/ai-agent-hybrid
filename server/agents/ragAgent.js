const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { searchSimilar } = require('../utils/embeddingService');

/**
 * RAG Agent that retrieves context and generates AI responses
 * @param {string} message - User's message/query
 * @returns {Promise<string>} - AI's response with context
 */
async function ragAgent(message) {
  try {
    // Validate API key
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set in environment variables');
    }

    // Step 1: Search for similar documents in Pinecone
    const similarDocs = await searchSimilar(message, 3);

    // Step 2: Combine top matches into a single context string
    const context = similarDocs
      .map((doc, idx) => `[Context ${idx + 1} from ${doc.source}]: ${doc.text}`)
      .join('\n\n');

    // Step 3: Create system prompt
    const systemPrompt = 'You are an AI assistant. Use the following context if relevant, otherwise answer normally.';

    // Step 4: Initialize ChatOpenAI
    const chatModel = new ChatOpenAI({
      openAIApiKey: process.env.OPENAI_API_KEY,
      temperature: 0.7,
      modelName: 'gpt-3.5-turbo',
    });

    // Step 5: Construct messages with system prompt, context, and user message
    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(`Context:\n${context}\n\nUser Question: ${message}`),
    ];

    // Step 6: Call the model
    const response = await chatModel.invoke(messages);

    // Step 7: Extract and return the response
    const reply = response.content || String(response);

    return reply;
  } catch (error) {
    console.error('RAG Agent error:', error);

    // Provide user-friendly error messages
    if (error.message.includes('API key')) {
      throw new Error('OpenAI API key is missing or invalid');
    } else if (error.message.includes('PINECONE')) {
      throw new Error('Pinecone configuration error. Please check your environment variables.');
    } else if (error.message.includes('rate limit')) {
      throw new Error('API rate limit exceeded. Please try again later.');
    } else {
      throw new Error(`Failed to get RAG response: ${error.message}`);
    }
  }
}

module.exports = { ragAgent };
