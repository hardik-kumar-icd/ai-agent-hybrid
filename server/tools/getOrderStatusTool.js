const axios = require('axios');
const platformConfig = require('../config/platform');

/**
 * Tool: get_order_status
 * Fetches real-time order info from CMS API (WordPress/WooCommerce or Magento 2)
 */
async function getOrderStatusTool({ order_id, email }) {
  try {
    // Validate inputs
    if (!order_id || !email) {
      throw new Error('Both order_id and email are required');
    }

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

        orderData = {
          id: order.id.toString(),
          status: order.status,
          total: order.total || order.total_formatted || null,
          currency: order.currency || 'NOK',
          tracking: tracking,
          delivery_date: deliveryDate
        };
      } catch (error) {
        if (error.response?.status === 404) {
          throw new Error(`Order ${order_id} not found`);
        } else if (error.response?.status === 401 || error.response?.status === 403) {
          throw new Error('Authentication failed. Please check API credentials.');
        } else {
          throw new Error(`WordPress API error: ${error.message}`);
        }
      }
    } else if (platform === 'magento') {
      // Magento 2 API call
      const apiUrl = `${endpoints.magento}/orders/${order_id}`;

      try {
        const response = await axios.get(apiUrl, {
          headers: {
            'Authorization': `Bearer ${auth.magento.bearerToken}`,
            'Content-Type': 'application/json'
          }
        });

        const order = response.data;

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
          throw new Error(`Order ${order_id} not found`);
        } else if (error.response?.status === 401 || error.response?.status === 403) {
          throw new Error('Authentication failed. Please check API credentials.');
        } else {
          throw new Error(`Magento API error: ${error.message}`);
        }
      }
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    // Return normalized order data
    return {
      order_id: orderData.id,
      status: orderData.status,
      total: orderData.total,
      currency: orderData.currency,
      tracking: orderData.tracking,
      delivery_date: orderData.delivery_date
    };
  } catch (error) {
    throw new Error(`Failed to get order status: ${error.message}`);
  }
}

// Export as LangChain tool
const getOrderStatusToolSchema = {
  name: 'get_order_status',
  description: 'Fetch real-time order information from the CMS API (WordPress/WooCommerce or Magento 2). Use this when you need the most up-to-date order status from the live system.',
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
