const fs = require('fs');
const path = require('path');

/**
 * Tool: get_order_details
 * Fetches cached order data from orders.json
 */
async function getOrderDetailsTool({ order_id, email }) {
  try {
    // Validate inputs
    if (!order_id || !email) {
      throw new Error('Both order_id and email are required');
    }

    // Read orders from JSON file
    const ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
    const ordersData = fs.readFileSync(ordersPath, 'utf-8');
    const orders = JSON.parse(ordersData);

    // Find order matching both order_id and email
    const order = orders.find(
      o => o.id === order_id.toString() && o.email.toLowerCase() === email.toLowerCase()
    );

    if (!order) {
      throw new Error(`Order ${order_id} not found for email ${email}`);
    }

    // Return normalized order data
    return {
      order_id: order.id,
      status: order.status,
      total: order.total || null,
      currency: order.currency || 'NOK',
      tracking: order.tracking || null,
      delivery_date: order.delivery_date || null
    };
  } catch (error) {
    throw new Error(`Failed to get order details: ${error.message}`);
  }
}

// Export as LangChain tool
const getOrderDetailsToolSchema = {
  name: 'get_order_details',
  description: 'Fetch cached order data (status, tracking, delivery date) from the local orders database. Use this for quick lookups of order information.',
  parameters: {
    type: 'object',
    properties: {
      order_id: {
        type: 'string',
        description: 'The order ID, e.g., 5501 or V-9901'
      },
      email: {
        type: 'string',
        description: 'The customer\'s email for verification'
      }
    },
    required: ['order_id', 'email']
  }
};

module.exports = {
  getOrderDetailsTool,
  getOrderDetailsToolSchema
};
