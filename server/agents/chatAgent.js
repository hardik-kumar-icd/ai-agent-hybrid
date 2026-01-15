const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage } = require('@langchain/core/messages');

/**
 * Chat agent function that uses LangChain ChatOpenAI to generate AI responses
 * @param {string} message - The user's message/prompt
 * @param {string} [conversationId] - Optional conversation ID for context
 * @returns {Promise<string>} - The AI's reply as plain text
 */
async function chatAgent(message, conversationId) {
  try {
    // Validate API key
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set in environment variables');
    }

    // Initialize ChatOpenAI instance
    const chatModel = new ChatOpenAI({
      openAIApiKey: process.env.OPENAI_API_KEY,
      temperature: 0.7,
      modelName: 'gpt-3.5-turbo', // You can change this to 'gpt-4' if needed
    });

    // Create a HumanMessage from the user's message
    const messages = [new HumanMessage(message)];

    // Call the model with the message
    const response = await chatModel.invoke(messages);

    // Extract the text content from the response
    // In LangChain, the response is an AIMessage object with a content property
    const reply = response.content || String(response);

    return reply;
  } catch (error) {
    // Handle API errors gracefully
    console.error('ChatAgent error:', error);

    // Provide user-friendly error messages
    if (error.message.includes('API key')) {
      throw new Error('OpenAI API key is missing or invalid');
    } else if (error.message.includes('rate limit')) {
      throw new Error('OpenAI API rate limit exceeded. Please try again later.');
    } else if (error.message.includes('timeout')) {
      throw new Error('Request to OpenAI API timed out. Please try again.');
    } else if (error.response?.status === 401) {
      throw new Error('OpenAI API authentication failed. Please check your API key.');
    } else if (error.response?.status === 429) {
      throw new Error('OpenAI API quota exceeded. Please check your usage limits.');
    } else {
      throw new Error(`Failed to get AI response: ${error.message}`);
    }
  }
}

module.exports = { chatAgent };
