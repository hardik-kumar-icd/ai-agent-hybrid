/**
 * Widget Initialization Script
 * Standalone embeddable chat widget for WordPress/Magento
 */

import ChatWidget from './components/ChatWidget';
import { injectStyles } from './widget-styles';

// Inject CSS styles programmatically
injectStyles();

/**
 * Check if React and ReactDOM are available
 */
function checkDependencies() {
  if (typeof window === 'undefined') {
    return false;
  }
  
  if (!window.React || !window.ReactDOM) {
    return false;
  }
  
  // Check for ReactDOM.createRoot (React 18+)
  if (!window.ReactDOM.createRoot) {
    console.warn('[VisorAIWidget] ReactDOM.createRoot not available. Make sure you\'re using React 18+');
    return false;
  }
  
  return true;
}

/**
 * Initialize the Visor AI Chat Widget
 * @param {Object} options - Configuration options
 * @param {string} options.selector - CSS selector for the container element (default: '#visor-ai-widget')
 * @param {string} options.baseUrl - Backend API base URL
 * @param {string} options.themeColor - Primary theme color (hex)
 * @param {string} options.accentColor - Accent theme color (hex)
 * @param {string} options.mode - Widget mode: 'user' (default) or 'admin'
 * @param {string} options.adminToken - Admin API token (required for admin mode)
 */
function init(options = {}) {
  // Check if React/ReactDOM are available
  if (!checkDependencies()) {
    console.error('[VisorAIWidget] React or ReactDOM not available');
    console.error('[VisorAIWidget] Make sure React and ReactDOM are loaded BEFORE widget.bundle.js');
    console.error('[VisorAIWidget] Load order: React → ReactDOM → widget.bundle.js → init script');
    
    // Retry after a delay
    setTimeout(() => {
      if (checkDependencies()) {
        console.log('[VisorAIWidget] Retrying initialization...');
        init(options);
      }
    }, 500);
    return;
  }

  const {
    selector = '#visor-ai-widget',
    baseUrl,
    themeColor,
    accentColor,
    mode = 'user',
    adminToken
  } = options;

  // Find or create container
  let container = document.querySelector(selector);
  
  if (!container) {
    container = document.createElement('div');
    container.id = selector.replace('#', '');
    document.body.appendChild(container);
  }

  // Get baseUrl from data attribute if not provided
  const dataBaseUrl = container.getAttribute('data-base-url') || 
                      container.getAttribute('data-api-base') ||
                      document.querySelector('[data-base-url]')?.getAttribute('data-base-url') ||
                      document.querySelector('[data-api-base]')?.getAttribute('data-api-base');
  const finalBaseUrl = baseUrl || dataBaseUrl;

  // Get theme colors from data attributes if not provided
  const dataThemeColor = container.getAttribute('data-theme-color');
  const dataAccentColor = container.getAttribute('data-accent-color');
  const finalThemeColor = themeColor || dataThemeColor;
  const finalAccentColor = accentColor || dataAccentColor;

  // Get mode from data attribute if not provided
  const dataMode = container.getAttribute('data-mode');
  const finalMode = mode || dataMode || 'user';

  // Get admin token from data attribute if not provided
  const dataAdminToken = container.getAttribute('data-admin-token');
  const dataToken = container.getAttribute('data-token');
  const finalAdminToken = adminToken || dataAdminToken || dataToken;

  // Render the widget using window.React/ReactDOM directly
  try {
    const ReactLib = window.React;
    const ReactDOMLib = window.ReactDOM;
    
    const root = ReactDOMLib.createRoot(container);
    root.render(
      ReactLib.createElement(ReactLib.StrictMode, null,
        ReactLib.createElement(ChatWidget, {
          baseUrl: finalBaseUrl,
          themeColor: finalThemeColor,
          accentColor: finalAccentColor,
          mode: finalMode,
          adminToken: finalAdminToken
        })
      )
    );
    console.log('[VisorAIWidget] Widget initialized successfully');
  } catch (error) {
    console.error('[VisorAIWidget] Error rendering widget:', error);
    console.error('[VisorAIWidget] Error details:', error.message);
  }
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
const VisorAIWidget = {
  init,
  initFromElement
};

// Set up global window object
if (typeof window !== 'undefined') {
  window.VisorAIWidget = VisorAIWidget;
}

export default VisorAIWidget;
