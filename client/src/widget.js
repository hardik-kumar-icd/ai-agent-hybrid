/**
 * Widget Initialization Script
 * Allows embedding the chat widget on WordPress/Magento sites
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import ChatWidget from './components/ChatWidget';
import './components/ChatWidget.css';
import './components/ChatMessage.css';

/**
 * Initialize the Visor AI Chat Widget
 * @param {Object} options - Configuration options
 * @param {string} options.selector - CSS selector for the container element (default: '#visor-chat-widget')
 * @param {string} options.baseUrl - Backend API base URL
 * @param {string} options.themeColor - Primary theme color (hex)
 * @param {string} options.accentColor - Accent theme color (hex)
 * @param {string} options.mode - Widget mode: 'user' (default) or 'admin'
 * @param {string} options.adminToken - Admin API token (required for admin mode)
 */
function init(options = {}) {
  const {
    selector = '#visor-chat-widget',
    baseUrl,
    themeColor,
    accentColor,
    mode = 'user',
    adminToken
  } = options;

  // Find or create container
  let container = document.querySelector(selector);
  
  if (!container) {
    // Create container if it doesn't exist
    container = document.createElement('div');
    container.id = selector.replace('#', '');
    document.body.appendChild(container);
  }

  // Get baseUrl from data attribute if not provided
  // Support both data-base-url and data-api-base for compatibility
  const dataBaseUrl = container.getAttribute('data-base-url') || 
                      container.getAttribute('data-api-base') ||
                      document.querySelector('[data-base-url]')?.getAttribute('data-base-url') ||
                      document.querySelector('[data-api-base]')?.getAttribute('data-api-base');
  const finalBaseUrl = baseUrl || dataBaseUrl || process.env.REACT_APP_API_BASE_URL;

  // Get theme colors from data attributes if not provided
  const dataThemeColor = container.getAttribute('data-theme-color');
  const dataAccentColor = container.getAttribute('data-accent-color');
  const finalThemeColor = themeColor || dataThemeColor;
  const finalAccentColor = accentColor || dataAccentColor;

  // Get mode from data attribute if not provided
  const dataMode = container.getAttribute('data-mode');
  const finalMode = mode || dataMode || 'user';

  // Get admin token from data attribute or environment if not provided
  const dataAdminToken = container.getAttribute('data-admin-token');
  const finalAdminToken = adminToken || dataAdminToken || process.env.REACT_APP_ADMIN_TOKEN;

  // Render the widget
  const root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <ChatWidget
        baseUrl={finalBaseUrl}
        themeColor={finalThemeColor}
        accentColor={finalAccentColor}
        mode={finalMode}
        adminToken={finalAdminToken}
      />
    </React.StrictMode>
  );

  console.log('[VisorAIWidget] Widget initialized successfully');
}

/**
 * Initialize widget from HTML element attributes
 * Reads data-base-url, data-admin, and data-token from the element
 * @param {string} selector - CSS selector for the container element
 */
function initFromElement(selector) {
  const container = document.querySelector(selector);
  
  if (!container) {
    console.error(`[VisorAIWidget] Element not found: ${selector}`);
    return;
  }

  // Read attributes from the element
  const dataBaseUrl = container.getAttribute('data-base-url') || 
                      container.getAttribute('data-api-base');
  const dataAdmin = container.getAttribute('data-admin');
  const dataToken = container.getAttribute('data-token');
  
  // Convert data-admin to mode ('admin' or 'user')
  const mode = dataAdmin === 'true' ? 'admin' : 'user';
  
  // Call init() with the extracted values
  init({
    selector: selector,
    baseUrl: dataBaseUrl,
    mode: mode,
    adminToken: dataToken
  });
}

// Export global initialization functions
if (typeof window !== 'undefined') {
  window.VisorAIWidget = {
    init: init,
    initFromElement: initFromElement
  };
}

export default { init, initFromElement };
