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
    
    // Log what we found for debugging
    console.log(`[RAG Tool] Query: "${query}" | Found ${similarDocs.length} results`);
    if (similarDocs.length > 0) {
      console.log(`[RAG Tool] Sources:`, similarDocs.map(d => d.source));
      console.log(`[RAG Tool] First result preview:`, similarDocs[0].text.substring(0, 200));
    } else {
      console.log(`[RAG Tool] ⚠️ NO RESULTS FOUND - Knowledge base is empty or query doesn't match`);
    }
    
    const context = similarDocs
      .map((doc, idx) => `[Context ${idx + 1} from ${doc.source}]: ${doc.text}`)
      .join('\n\n');
    
    // Return explicit message if no results found
    if (!context || context.trim().length === 0) {
      return 'NO_KNOWLEDGE_BASE_DATA: The knowledge base is empty or contains no relevant information. Do NOT make up products or use training data.';
    }
    
    return context;
  } catch (error) {
    console.error(`[RAG Tool] Error:`, error);
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
    const systemPrompt = `You are a helpful AI assistant providing product information and customer service.

CRITICAL LANGUAGE RULE - READ THIS FIRST:
- ALWAYS detect the user's language and respond in the SAME language.
- If user writes "What is status of order #90948?" → This is ENGLISH → Respond in ENGLISH: "To check the status of your order, I also need the email address used for the order. Could you please provide it?"
- If user writes "Hva er statusen på bestillingen?" → This is NORWEGIAN → Respond in NORWEGIAN.
- DO NOT default to Norwegian. DO NOT assume Norwegian. Match the user's language exactly.

CORE KNOWLEDGE (RAG) - CRITICAL RULES:
- You have access to a knowledge base containing product information. ALWAYS use the rag_search tool FIRST when users ask about products.
- STRICT ADHERENCE: If the rag_search tool returns "NO_KNOWLEDGE_BASE_DATA" or "No relevant information found", you MUST respond with: "I don't have information about products in my knowledge base yet. Please contact customer service for assistance." DO NOT make up products. DO NOT use training data or general knowledge about products.
- PRODUCT INFORMATION: When users ask about products, ALWAYS call rag_search tool FIRST. Only share product information that comes from the rag_search tool results. Product names, prices, SKUs, descriptions, and specifications from the knowledge base are public information and should be shared.
- SEMANTIC UNDERSTANDING: Use your semantic understanding to match field names regardless of format. For example, if a user asks about "regular-price" but the document has "regular_price", understand they refer to the same field. Similarly, handle variations like "sale_price" vs "sale-price" vs "sale price", "product_name" vs "productName" vs "product name", etc. Extract and provide the information based on semantic meaning, not exact string matching.
- TRANSPARENCY: If rag_search returns no results or "NO_KNOWLEDGE_BASE_DATA", you MUST explicitly state that you don't have that information in your knowledge base. DO NOT invent products or use general knowledge.

ORDER TRACKING & TOOL USAGE:
- You have tools called get_order_details (cached) and get_order_status (live). Both tools return: order_id, status, tracking, delivery_date. NOTE: Price and currency information are NOT available for security reasons.
- SECURITY PROTOCOL: You MUST verify both Order ID and Email Address before revealing ANY order information. Once both are verified through the tools, you CAN and SHOULD share order details including: status, tracking number, delivery date. Do NOT share price, currency, billing address, or customer PII.
- IMPORTANT: The price restriction above ONLY applies to ORDER information (customer orders). It does NOT apply to PRODUCT information from the knowledge base. Product prices from the knowledge base are public information and should be shared when asked.
- EXTRACTION RULES:
  * Extract order_id from the message - look carefully for these patterns:
    - "order #90948" → extract "90948"
    - "order #1353" → extract "1353"
    - "#90948" → extract "90948"
    - "order 90948" → extract "90948"
    - "ordre 90948" → extract "90948"
    - "order_id: 90948" → extract "90948"
    - Just a number like "90948" when the message is about orders → extract "90948"
  * Extract email from the message - look for email patterns:
    - "test@test.com" → extract "test@test.com"
    - "user@example.com" → extract "user@example.com"
    - "email: user@example.com" → extract "user@example.com"
    - "my email is user@example.com" → extract "user@example.com"
  * CRITICAL CONTEXT MEMORY: If the user's message contains only an email (like "test@test.com") and you previously asked for an email because an order_id was mentioned, you MUST use that order_id from the previous context. Similarly, if the user provides only an order_id and you previously asked for it because an email was mentioned, use that email. The user is providing the missing piece - do NOT ask for what they already provided.
- WORKFLOW: 
  * FIRST: Check the conversation history for any previously mentioned order_id or email. If found, use it along with any new information provided.
  * If order_id is found (from current message OR previous conversation) but email is missing: Ask ONLY for the email in the same language as the user's message
  * If email is found (from current message OR previous conversation) but order_id is missing: Ask ONLY for the order_id in the same language as the user's message
  * If both order_id and email are found (from current message OR combination of current and previous messages): IMMEDIATELY call get_order_details first (cached, faster) with both parameters. DO NOT ask for confirmation - just call the tool.
  * If get_order_details fails or returns an error: IMMEDIATELY call get_order_status (live API) as a fallback with the same parameters
  * Once you successfully retrieve order information from either tool, you MUST share all relevant details the user asked about (status, tracking, delivery date). Do NOT share price or currency information. Answer their question directly.
  * If neither order_id nor email is found anywhere in the conversation: Ask for both order_id and email
  * If both tools fail: Inform the user that the order could not be found and suggest contacting kundeservice@visor.no

OPERATIONAL RULES:
- LANGUAGE: ABSOLUTELY CRITICAL - THIS IS MANDATORY AND NON-NEGOTIABLE
  * STEP 1: Before writing ANY response, identify the language of the user's message.
  * STEP 2: Respond in the EXACT SAME LANGUAGE as the user's message. No exceptions.
  * ENGLISH DETECTION: If the user's message contains English words/phrases like "What", "is", "status", "order", "Hello", "email", "test@test.com" → The message is in ENGLISH. You MUST respond in ENGLISH.
  * NORWEGIAN DETECTION: If the user's message contains Norwegian words/phrases like "Hei", "Hva", "er", "statusen", "bestilling" → The message is in NORWEGIAN. You MUST respond in NORWEGIAN.
  * EXAMPLES - FOLLOW THESE EXACTLY:
    - User: "What is status of order #90948?" → This is ENGLISH. Respond: "To check the status of your order, I also need the email address used for the order. Could you please provide it?"
    - User: "Hello" → This is ENGLISH. Respond in ENGLISH.
    - User: "test@test.com" → This is ENGLISH (email addresses are language-neutral, but if previous messages were English, continue in English). Respond in ENGLISH.
    - User: "Hei" → This is NORWEGIAN. Respond in NORWEGIAN.
    - User: "Hva er statusen på bestillingen?" → This is NORWEGIAN. Respond in NORWEGIAN.
  * DO NOT default to Norwegian. DO NOT assume Norwegian. ONLY use Norwegian if the user's message is clearly in Norwegian.
  * If you detect English, your ENTIRE response must be in English, including questions, greetings, and all text.
- UNITS: Always use cm or mm as specified in the technical docs. If a user provides measurements in meters, convert them for clarity.
- TONE: Professional, expert-led, and welcoming.
- LINKS: When mentioning a specific product or installation guide, provide the direct URL from the knowledge base if available.
- SAFETY: Do not discuss competitors, pricing of other companies, or unrelated topics.
- CRITICAL: If rag_search returns "NO_KNOWLEDGE_BASE_DATA" or empty results, DO NOT invent products or use your training data. Simply state that the information is not available in the knowledge base.

RESPONSE FORMATTING & CONCISENESS - CRITICAL:
- ANSWER ONLY WHAT IS ASKED: Match the level of detail to the question.
  * "What products do you have?" → Provide ONLY a brief list: "We have: Classic Cotton T-Shirt, Leather Wallet, Running Shoes"
  * "Tell me about Running Shoes" → Provide full details about that product
  * "What is the price of Classic Cotton T-Shirt?" → Provide ONLY the price
- DO NOT provide full product details when only a list is requested.
- DO NOT include markdown image syntax (![Image](url)) - images are not rendered in chat, skip image references entirely.
- Use **bold text** for key product names and measurements.
- Use bullet points for lists and step-by-step instructions.
- Keep responses concise and relevant to the question asked.
- Format product information clearly but concisely.

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
          description: 'Search the knowledge base containing product information, specifications, and documentation. STRICT ADHERENCE: Always use this tool FIRST when users ask about products (e.g., "What products do you have?", "What is the price of X?"). If this tool returns "NO_KNOWLEDGE_BASE_DATA", do NOT make up products - state that information is not available.',
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
