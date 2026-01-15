const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { searchSimilar } = require('../utils/embeddingService');
const { getOrderDetailsTool } = require('../tools/getOrderDetailsTool');
const { getOrderStatusTool } = require('../tools/getOrderStatusTool');

/**
 * RAG Tool for product knowledge
 */
async function ragTool({ query }) {
  try {
    const similarDocs = await searchSimilar(query, 3);
    const context = similarDocs
      .map((doc, idx) => `[Context ${idx + 1} from ${doc.source}]: ${doc.text}`)
      .join('\n\n');
    
    return context || 'No relevant information found in knowledge base.';
  } catch (error) {
    return `Error searching knowledge base: ${error.message}`;
  }
}

/**
 * Unified Visor.no AI Agent
 * Combines RAG, order details, and order status tools
 * Uses a simplified approach with function calling
 */
async function processVisorMessage(message) {
  try {
    // Validate API key
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set in environment variables');
    }

    // System prompt matching Visor.no Expert Assistant workflow
    const systemPrompt = `You are the Official Visor.no Digital Expert. Your goal is to provide world-class customer service for Norwegian customers looking for sun shading solutions (plisségardiner, rullegardiner, lamellgardiner, etc.). You are professional, precise, and helpful.

CORE KNOWLEDGE (RAG):
- You have access to a knowledge base containing all product specifications, measurement guides, and installation manuals from visor.no.
- STRICT ADHERENCE: Always prioritize information found in the knowledge base. If a user asks a technical question (e.g., "What is the max width of an AO20 model?"), search the documents using rag_search tool BEFORE answering.
- TRANSPARENCY: If the information is not in your knowledge base, state that you don't know and offer to connect them with a human specialist at kundeservice@visor.no.

ORDER TRACKING & TOOL USAGE:
- You have tools called get_order_details (cached) and get_order_status (live). Both tools return: order_id, status, total, currency, tracking, delivery_date.
- SECURITY PROTOCOL: You MUST verify both Order ID and Email Address before revealing ANY order information. Once both are verified through the tools, you CAN and SHOULD share order details including: status, total amount, tracking number, delivery date, and other order information.
- EXTRACTION RULES:
  * Extract order_id from the message (look for patterns like "order 1353", "order_id: 1353", "ordre 1353", "order #1353", "#1353", or just "1353" when context suggests it's an order number)
  * Extract email from the message (look for email patterns like "user@example.com", "email: user@example.com", "my email is user@example.com", "moxi@icecubedigital.com")
- WORKFLOW: 
  * If order_id is found but email is missing: Ask ONLY for the email in the same language as the user's message
  * If both order_id and email are found: IMMEDIATELY call get_order_details first (cached, faster) with both parameters. DO NOT ask for confirmation - just call the tool.
  * If get_order_details fails or returns an error: IMMEDIATELY call get_order_status (live API) as a fallback with the same parameters
  * Once you successfully retrieve order information from either tool, you MUST share all relevant details the user asked about (status, total, tracking, delivery date, etc.). Answer their question directly.
  * If neither order_id nor email is found: Ask for both order_id and email
  * If both tools fail: Inform the user that the order could not be found and suggest contacting kundeservice@visor.no

OPERATIONAL RULES:
- LANGUAGE: CRITICAL - Detect the user's language from their message. If they write in English, respond in English. If they write in Norwegian, respond in Norwegian. Default to Norwegian only if language is unclear.
- UNITS: Always use cm or mm as specified in the technical docs. If a user provides measurements in meters, convert them for clarity.
- TONE: Professional, expert-led, and welcoming. Use "Vi" (We) in Norwegian, "We" in English when referring to Visor.no.
- LINKS: When mentioning a specific product or installation guide, provide the direct URL from the knowledge base if available.
- SAFETY: Do not discuss competitors, pricing of other companies, or unrelated topics.

RESPONSE FORMATTING:
- Use **bold text** for key product names and measurements.
- Use bullet points for step-by-step instructions (like measuring or mounting).
- Keep paragraphs short (2-3 sentences) for better readability on mobile devices.

Be helpful, professional, and expert-led.`;

    // Initialize ChatOpenAI model with function calling
    const model = new ChatOpenAI({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: 'gpt-4o',
      temperature: 0.4,
    }).bindTools([
      {
        type: 'function',
        function: {
          name: 'rag_search',
          description: 'Search the Visor.no knowledge base containing all product specifications, measurement guides, and installation manuals. STRICT ADHERENCE: Always use this tool FIRST for technical questions (e.g., "What is the max width of an AO20 model?"). Only answer technical questions after searching the knowledge base.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query about products, specifications, measurements, installation, or technical information'
              }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_order_details',
          description: 'Fetch cached order data (status, tracking, delivery date) from the local orders database. Use this FIRST for quick lookups. Requires both order_id and email for security.',
          parameters: {
            type: 'object',
            properties: {
              order_id: {
                type: 'string',
                description: 'The order ID, e.g., 5501 or V-9901'
              },
              email: {
                type: 'string',
                description: 'The customer\'s email address used when placing the order (REQUIRED for security verification)'
              }
            },
            required: ['order_id', 'email']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_order_status',
          description: 'Fetch real-time order information from the CMS API (WordPress/WooCommerce or Magento 2). Use this when you need the most up-to-date order status from the live system. Requires both order_id and email for security.',
          parameters: {
            type: 'object',
            properties: {
              order_id: {
                type: 'string',
                description: 'The unique order number provided to the customer (e.g., \'12345\' or \'V-9901\').'
              },
              email: {
                type: 'string',
                description: 'The email address used when placing the order (REQUIRED for security verification).'
              }
            },
            required: ['order_id', 'email']
          }
        }
      }
    ]);

    // Create messages
    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(message)
    ];

    // Call the model
    let response = await model.invoke(messages);

    // Handle tool calls - check for different response structures
    // In LangChain, tool_calls might be on the response directly or in additional_kwargs
    let toolCalls = [];
    
    if (response.tool_calls && Array.isArray(response.tool_calls)) {
      toolCalls = response.tool_calls;
    } else if (response.toolCalls && Array.isArray(response.toolCalls)) {
      toolCalls = response.toolCalls;
    } else if (response.additional_kwargs?.tool_calls && Array.isArray(response.additional_kwargs.tool_calls)) {
      toolCalls = response.additional_kwargs.tool_calls;
    }

    while (toolCalls && toolCalls.length > 0) {
      const toolResults = [];

      for (const toolCall of toolCalls) {
        try {
          // Handle different tool call structures
          // LangChain tool calls can have different formats:
          // Format 1: { id, type, function: { name, arguments } } - OpenAI format
          // Format 2: { name, args, type, id } - LangChain simplified format
          let functionName, functionArgs, toolCallId;
          
          if (toolCall.name && toolCall.args) {
            // LangChain format: { name, args } - args is already an object
            functionName = toolCall.name;
            functionArgs = toolCall.args;
          } else if (toolCall.function) {
            // OpenAI format: { function: { name, arguments } } - arguments is a string
            functionName = toolCall.function.name;
            functionArgs = toolCall.function.arguments || '{}';
          } else if (toolCall.name) {
            // Fallback: { name, arguments }
            functionName = toolCall.name;
            functionArgs = toolCall.arguments || '{}';
          } else {
            console.error('Tool call structure unexpected:', JSON.stringify(toolCall, null, 2));
            continue;
          }
          
          toolCallId = toolCall.id || toolCall.tool_call_id;

          if (!functionName) {
            console.error('Tool call missing function name:', JSON.stringify(toolCall, null, 2));
            continue;
          }

          let result;
          let args;
          try {
            // args might already be an object (from toolCall.args) or a string (from function.arguments)
            if (typeof functionArgs === 'string') {
              args = JSON.parse(functionArgs);
            } else if (typeof functionArgs === 'object' && functionArgs !== null) {
              args = functionArgs;
            } else {
              args = {};
            }
          } catch (parseError) {
            console.error('Error parsing function arguments:', parseError);
            args = {};
          }

          switch (functionName) {
            case 'rag_search':
              result = await ragTool(args);
              break;
            case 'get_order_details':
              console.log(`[Tool Call] get_order_details with args:`, args);
              try {
                result = await getOrderDetailsTool(args);
                console.log(`[Tool Result] get_order_details success:`, result);
                result = JSON.stringify(result);
              } catch (err) {
                console.error(`[Tool Error] get_order_details failed:`, err.message);
                throw err;
              }
              break;
            case 'get_order_status':
              console.log(`[Tool Call] get_order_status with args:`, args);
              try {
                result = await getOrderStatusTool(args);
                console.log(`[Tool Result] get_order_status success:`, result);
                result = JSON.stringify(result);
              } catch (err) {
                console.error(`[Tool Error] get_order_status failed:`, err.message);
                throw err;
              }
              break;
            default:
              result = `Unknown tool: ${functionName}`;
          }

          toolResults.push({
            tool_call_id: toolCallId,
            role: 'tool',
            name: functionName,
            content: result
          });
        } catch (error) {
          console.error('Error executing tool:', error);
          console.error('Tool call that failed:', JSON.stringify(toolCall, null, 2));
          
          let functionName = 'unknown';
          let toolCallId = 'unknown';
          
          try {
            if (toolCall.function) {
              functionName = toolCall.function.name || 'unknown';
            } else if (toolCall.name) {
              functionName = toolCall.name;
            }
            toolCallId = toolCall.id || toolCall.tool_call_id || 'unknown';
          } catch (e) {
            console.error('Error extracting tool call info:', e);
          }
          
          toolResults.push({
            tool_call_id: toolCallId,
            role: 'tool',
            name: functionName,
            content: `Error: ${error.message}`
          });
        }
      }

      // Add tool results and get next response
      messages.push(response);
      messages.push(...toolResults);
      response = await model.invoke(messages);
      
      // Update toolCalls for next iteration - check all possible locations
      toolCalls = [];
      if (response.tool_calls && Array.isArray(response.tool_calls)) {
        toolCalls = response.tool_calls;
      } else if (response.toolCalls && Array.isArray(response.toolCalls)) {
        toolCalls = response.toolCalls;
      } else if (response.additional_kwargs?.tool_calls && Array.isArray(response.additional_kwargs.tool_calls)) {
        toolCalls = response.additional_kwargs.tool_calls;
      }
    }

    // Return the final response
    return response.content || 'Jeg beklager, jeg kunne ikke generere et svar.';
  } catch (error) {
    console.error('Error processing Visor message:', error);
    throw new Error(`Failed to process message: ${error.message}`);
  }
}

module.exports = {
  processVisorMessage
};
