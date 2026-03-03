/**
 * Environment Verification Route
 * Allows authorized admins to check the status of critical API integrations
 */

const express = require('express');
const router = express.Router();
const { OpenAI } = require('openai');
const axios = require('axios');
const { initializePinecone } = require('../utils/embeddingService');
const platformConfig = require('../config/platform');

/**
 * Test OpenAI connectivity
 * @returns {Promise<{status: string, error?: string}>}
 */
async function testOpenAI() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return { status: 'error', error: 'OPENAI_API_KEY not configured' };
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Lightweight test: list models with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      await openai.models.list({ signal: controller.signal });
      clearTimeout(timeoutId);
      return { status: 'active' };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        return { status: 'error', error: 'Request timeout' };
      }
      throw error;
    }
  } catch (error) {
    return { status: 'error', error: error.message || 'Connection failed' };
  }
}

/**
 * Test Pinecone connectivity
 * @returns {Promise<{status: string, error?: string}>}
 */
async function testPinecone() {
  try {
    if (!process.env.PINECONE_API_KEY) {
      return { status: 'error', error: 'PINECONE_API_KEY not configured' };
    }

    if (!process.env.PINECONE_INDEX_NAME) {
      return { status: 'error', error: 'PINECONE_INDEX_NAME not configured' };
    }

    // Initialize Pinecone and test connectivity with timeout
    try {
      const index = await Promise.race([
        initializePinecone(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timeout')), 5000);
        })
      ]);

      // Try to query the index to verify it's accessible
      // Use a simple query with minimal data
      await Promise.race([
        index.query({
          vector: new Array(3072).fill(0), // Dummy vector for test
          topK: 1,
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timeout')), 5000);
        })
      ]);

      return { status: 'active' };
    } catch (error) {
      if (error.message === 'Timeout') {
        return { status: 'error', error: 'Request timeout' };
      }
      // If index doesn't exist or query fails, still consider it an error
      return { status: 'error', error: error.message || 'Connection failed' };
    }
  } catch (error) {
    return { status: 'error', error: error.message || 'Connection failed' };
  }
}

/**
 * Test WooCommerce connectivity
 * @returns {Promise<{status: string, error?: string}>}
 */
async function testWooCommerce() {
  try {
    const { platform, endpoints, auth } = platformConfig;

    if (platform !== 'wordpress') {
      return { status: 'error', error: `Platform is set to '${platform}', not 'wordpress'` };
    }

    if (!auth.wordpress.consumerKey || !auth.wordpress.consumerSecret) {
      return { status: 'error', error: 'WooCommerce credentials not configured' };
    }

    const apiUrl = `${endpoints.wordpress}/orders?per_page=1`;
    const credentials = Buffer.from(
      `${auth.wordpress.consumerKey}:${auth.wordpress.consumerSecret}`
    ).toString('base64');

    // Make request with timeout
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    // Check if response is successful
    if (response.status >= 200 && response.status < 300) {
      return { status: 'active' };
    } else {
      return { status: 'error', error: `HTTP ${response.status}` };
    }
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return { status: 'error', error: 'Request timeout' };
    }
    if (error.response) {
      return { status: 'error', error: `HTTP ${error.response.status}` };
    }
    return { status: 'error', error: error.message || 'Connection failed' };
  }
}

/**
 * GET /api/verify-env
 * Protected admin endpoint to verify environment and API integrations
 */
router.get('/', async (req, res) => {
  try {
    // Run all tests in parallel for faster response
    const [openaiResult, pineconeResult, woocommerceResult] = await Promise.all([
      testOpenAI(),
      testPinecone(),
      testWooCommerce()
    ]);

    // Build response
    const services = {
      openai: openaiResult.status,
      pinecone: pineconeResult.status,
      // woocommerce: woocommerceResult.status
    };

    // Determine overall status
    const allActive = Object.values(services).every(status => status === 'active');
    const overallStatus = allActive ? 'ok' : 'error';

    // Build details object for errors
    const details = {};
    if (openaiResult.status === 'error') {
      details.openai = 'error';
    }
    if (pineconeResult.status === 'error') {
      details.pinecone = 'error';
    }
    if (woocommerceResult.status === 'error') {
      details.woocommerce = 'error';
    }

    // Log results
    if (allActive) {
      console.log('[EnvCheck] All services operational');
    } else {
      // Log partial failures with masked errors
      const failedServices = Object.entries(services)
        .filter(([_, status]) => status === 'error')
        .map(([name]) => name);
      console.log(`[EnvCheck] Partial failure - Services down: ${failedServices.join(', ')}`);
    }

    // Build response
    const response = {
      status: overallStatus,
      services: services,
      timestamp: new Date().toISOString()
    };

    // Add error details if any services failed
    if (!allActive) {
      response.message = 'One or more services are unavailable.';
      response.details = details;
    }

    // Return appropriate status code
    const statusCode = allActive ? 200 : 503; // 503 Service Unavailable
    res.status(statusCode).json(response);

  } catch (error) {
    console.error('[EnvCheck] Unexpected error:', error.message);
    
    // Return error response without exposing stack traces
    res.status(500).json({
      status: 'error',
      message: 'Environment verification failed',
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;
