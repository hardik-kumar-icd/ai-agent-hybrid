require('dotenv').config();

/**
 * Platform configuration for Visor.no AI Agent
 * Supports both WordPress/WooCommerce and Magento 2
 */
const platformConfig = {
  // Platform type: 'wordpress' or 'magento'
  platform: process.env.CMS_PLATFORM || 'wordpress',
  
  // API endpoints
  endpoints: {
    wordpress: process.env.WORDPRESS_API_URL || 'https://visor.no/wp-json/wc/v3',
    magento: process.env.MAGENTO_API_URL || 'https://visor.no/rest/V1'
  },
  
  // Authentication credentials
  auth: {
    wordpress: {
      consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY || '',
      consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET || ''
    },
    magento: {
      bearerToken: process.env.MAGENTO_BEARER_TOKEN || ''
    }
  }
};

module.exports = platformConfig;
