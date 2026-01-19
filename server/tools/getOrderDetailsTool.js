const fs = require('fs');
const path = require('path');
const { sanitizeOrderData } = require('../utils/piiFilter');
const { getOrderStatusTool } = require('./getOrderStatusTool');
const { logOrderLookup } = require('../utils/securityLogger');

/**
 * Tool: get_order_details
 * Fetches cached order data from orders.json
 * Falls back to get_order_status if order not found in cache
 */
async function getOrderDetailsTool({ order_id, email }) {
  try {
    // Validate inputs
    if (!order_id || !email) {
      throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
    }

    // Log order lookup with masked data
    logOrderLookup(order_id, email, '[getOrderDetailsTool]');

    // Read orders from JSON file
    const ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
    const ordersData = fs.readFileSync(ordersPath, 'utf-8');
    const orders = JSON.parse(ordersData);

    // Find order matching both order_id and email
    const order = orders.find(
      o => o.id === order_id.toString() && o.email.toLowerCase() === email.toLowerCase()
    );

    if (order) {
      // Return sanitized order data (no PII, price, or address)
      return sanitizeOrderData(order);
    } else {
      // Fallback to live API if not found in cache
      try {
        const liveData = await getOrderStatusTool({ order_id, email });
        return sanitizeOrderData(liveData);
      } catch (fallbackError) {
        throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
      }
    }
  } catch (error) {
    if (error.message.includes('Beklager')) {
      throw error;
    }
    throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
  }
}

// Export as LangChain tool
const getOrderDetailsToolSchema = {
  name: 'get_order_details',
  description: 'Fetch cached order data (status, tracking, delivery date) from the local orders database. Use this FIRST for quick lookups. Falls back to live API if not found. Returns only: id, status, tracking, delivery_date. Does NOT return price, currency, or PII.',
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
