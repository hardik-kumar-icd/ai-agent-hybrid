const axios = require('axios');
const platformConfig = require('../config/platform');
const { sanitizeOrderData } = require('../utils/piiFilter');
const { logOrderLookup } = require('../utils/securityLogger');

/**
 * Tool: get_order_status
 * Fetches real-time order info from CMS API (WordPress/WooCommerce or Magento 2)
 */
async function getOrderStatusTool({ order_id, email }) {
  try {
    // Validate inputs
    if (!order_id || !email) {
      throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
    }

    // Log order lookup with masked data
    logOrderLookup(order_id, email, '[getOrderStatusTool]');

    const { platform, endpoints, auth } = platformConfig;
    let orderData;

    if (platform === 'wordpress') {
      // WordPress/WooCommerce API call
      const apiUrl = `${endpoints.wordpress}/orders/${order_id}`;
      const credentials = Buffer.from(
        `${auth.wordpress.consumerKey}:${auth.wordpress.consumerSecret}`
      ).toString('base64');

      try {
        const response = await axios.get(apiUrl, {
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json'
          }
        });

        const order = response.data;

        // Verify email matches
        if (order.billing?.email?.toLowerCase() !== email.toLowerCase()) {
          throw new Error('Email does not match the order');
        }

        // Extract tracking info (WooCommerce meta fields)
        const tracking = order.meta_data?.find(
          meta => meta.key === '_tracking_number' || meta.key === 'tracking_number'
        )?.value || null;

        // Extract delivery date (WooCommerce meta fields)
        const deliveryDate = order.meta_data?.find(
          meta => meta.key === '_delivery_date' || meta.key === 'delivery_date'
        )?.value || null;

        // Build order data without total/currency (will be sanitized)
        orderData = {
          id: order.id.toString(),
          status: order.status,
          tracking: tracking,
          delivery_date: deliveryDate
        };
      } catch (error) {
        if (error.response?.status === 404) {
          throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
        } else if (error.response?.status === 401 || error.response?.status === 403) {
          throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
        } else if (error.message.includes('Email does not match')) {
          throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
        } else {
          throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
        }
      }
    } else if (platform === 'magento') {
      // Magento 2: customers see increment_id (Order Number), not entity_id. Look up by increment_id first, then fallback to entity_id.
      const headers = {
        'Authorization': `Bearer ${auth.magento.bearerToken}`,
        'Content-Type': 'application/json'
      };

      try {
        let order = null;

        // 1) Try search by increment_id (customer-facing order number)
        const searchUrl = `${endpoints.magento}/orders?searchCriteria[filter_groups][0][filters][0][field]=increment_id&searchCriteria[filter_groups][0][filters][0][value]=${encodeURIComponent(String(order_id).trim())}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;
        const searchResponse = await axios.get(searchUrl, { headers });
        const items = searchResponse.data?.items || [];
        if (items.length > 0) {
          order = items[0];
        }

        // 2) Fallback: if no result and order_id looks like numeric entity_id, try direct GET by entity_id
        if (!order && /^\d+$/.test(String(order_id).trim())) {
          const directUrl = `${endpoints.magento}/orders/${order_id}`;
          try {
            const directResponse = await axios.get(directUrl, { headers });
            if (directResponse.data) order = directResponse.data;
          } catch (_) {
            // Ignore 404 from direct GET; we'll throw below
          }
        }

        if (!order) {
          throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
        }

        // Verify email matches
        if (order.customer_email?.toLowerCase() !== email.toLowerCase()) {
          throw new Error('Email does not match the order');
        }

        // Extract tracking info from shipments
        let tracking = null;
        if (order.extension_attributes?.shipping_assignments) {
          const shipment = order.extension_attributes.shipping_assignments[0]?.shipment;
          if (shipment?.tracks && shipment.tracks.length > 0) {
            tracking = shipment.tracks[0].track_number;
          }
        }

        // Extract delivery date
        const deliveryDate = order.extension_attributes?.shipping_assignments?.[0]
          ?.shipping?.address?.extension_attributes?.delivery_date || null;

        orderData = {
          id: order.increment_id || order.entity_id.toString(),
          status: order.status,
          tracking: tracking,
          delivery_date: deliveryDate
        };
      } catch (error) {
        if (error.response?.status === 404) {
          throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
        } else if (error.response?.status === 401 || error.response?.status === 403) {
          throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
        } else if (error.message.includes('Email does not match')) {
          throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
        } else if (error.message.includes('Beklager')) {
          throw error;
        } else {
          throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
        }
      }
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    // Return sanitized order data (no PII, price, or address)
    return sanitizeOrderData(orderData);
  } catch (error) {
    if (error.message.includes('Beklager')) {
      throw error;
    }
    throw new Error('Beklager, vi kunne ikke finne en ordre med den informasjonen. Vennligst kontroller ID og e-postadresse.');
  }
}

// Export as LangChain tool
const getOrderStatusToolSchema = {
  name: 'get_order_status',
  description: 'Fetch real-time order information from the CMS API (WordPress/WooCommerce or Magento 2). Use this when you need the most up-to-date order status from the live system. Returns only: id, status, tracking, delivery_date. Does NOT return price, currency, or PII.',
  parameters: {
    type: 'object',
    properties: {
      order_id: {
        type: 'string',
        description: 'The unique order number provided to the customer (e.g., \'12345\' or \'V-9901\').'
      },
      email: {
        type: 'string',
        description: 'The email address used when placing the order.'
      }
    },
    required: ['order_id', 'email']
  }
};

module.exports = {
  getOrderStatusTool,
  getOrderStatusToolSchema
};
