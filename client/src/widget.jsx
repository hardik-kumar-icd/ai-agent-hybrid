/**
 * Widget Initialization Script
 * Standalone embeddable chat widget for WordPress/Magento
 */

import ChatWidget from './components/ChatWidget';
// CSS is injected programmatically via Vite plugin (from component CSS files)


/**
 * Dynamically load React/ReactDOM from CDN if not available
 * Handles cases where Magento rewrites script URLs
 */
function loadReactDependencies() {
  return new Promise((resolve, reject) => {
    if (window.React && window.ReactDOM && window.ReactDOM.createRoot) {
      resolve();
      return;
    }
    
    const loadScript = (src) => {
      return new Promise((resolveScript, rejectScript) => {
        // Check if script already exists
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing) {
          existing.addEventListener('load', resolveScript);
          existing.addEventListener('error', rejectScript);
          return;
        }
        
        const script = document.createElement('script');
        script.src = src;
        script.crossOrigin = 'anonymous';
        script.async = false; // Load synchronously
        script.onload = resolveScript;
        script.onerror = () => rejectScript(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
      });
    };
    
    // Load React first, then ReactDOM
    loadScript('https://unpkg.com/react@18/umd/react.production.min.js')
      .then(() => loadScript('https://unpkg.com/react-dom@18/umd/react-dom.production.min.js'))
      .then(() => {
        if (window.React && window.ReactDOM && window.ReactDOM.createRoot) {
          resolve();
        } else {
          reject(new Error('React/ReactDOM loaded but not available on window object'));
        }
      })
      .catch(reject);
  });
}

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
  // Check if React/ReactDOM are available, if not try to load them
  if (!checkDependencies()) {
    loadReactDependencies()
      .then(() => init(options))
      .catch((error) => {
        console.error('[VisorAIWidget] Failed to load React/ReactDOM:', error);
        console.error('[VisorAIWidget] Make sure React and ReactDOM are loaded BEFORE widget.bundle.js');
        console.error('[VisorAIWidget] Load order: React → ReactDOM → widget.bundle.js');
        console.error('[VisorAIWidget] Use absolute URLs: https://unpkg.com/react@18/umd/react.production.min.js');
        
        // Retry after a delay as fallback
        setTimeout(() => {
          if (checkDependencies()) init(options);
        }, 1000);
      });
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
  
  // Prevent double initialization
  if (container.hasAttribute('data-widget-initialized')) return;

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
    const widgetElement = ReactLib.createElement(ChatWidget, {
      baseUrl: finalBaseUrl,
      themeColor: finalThemeColor,
      accentColor: finalAccentColor,
      mode: finalMode,
      adminToken: finalAdminToken
    });
    const strictModeElement = ReactLib.createElement(ReactLib.StrictMode, null, widgetElement);
    root.render(strictModeElement);
    container.setAttribute('data-widget-initialized', 'true');
  } catch (error) {
    console.error('[VisorAIWidget] ❌ Error rendering widget:', error);
    console.error('[VisorAIWidget] Error details:', error.message);
    console.error('[VisorAIWidget] Error stack:', error.stack);
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

  let autoInitAttempts = 0;
  const MAX_AUTO_INIT_ATTEMPTS = 50; // Try for ~5 seconds (50 * 100ms)

  function autoInit() {
    autoInitAttempts++;

    if (!checkDependencies()) {
      if (autoInitAttempts === 1) {
        loadReactDependencies()
          .then(() => autoInit())
          .catch(() => {
            if (autoInitAttempts < MAX_AUTO_INIT_ATTEMPTS) setTimeout(autoInit, 100);
          });
        return;
      }
      
      // Retry after a delay
      if (autoInitAttempts < MAX_AUTO_INIT_ATTEMPTS) {
        setTimeout(autoInit, 100);
      } else {
        console.error('[VisorAIWidget] Failed to initialize: React/ReactDOM not available after', MAX_AUTO_INIT_ATTEMPTS, 'attempts');
        console.error('[VisorAIWidget] Please ensure React and ReactDOM scripts are loaded with absolute URLs');
      }
      return;
    }
    
    // Look for widget container elements
    const selectors = [
      '#visor-ai-widget',
      '[data-base-url]',
      '[data-api-base]'
    ];

    let container = null;
    for (const selector of selectors) {
      container = document.querySelector(selector);
      if (container && (container.id === 'visor-ai-widget' || container.hasAttribute('data-base-url') || container.hasAttribute('data-api-base'))) break;
    }

    if (!container) {
      if (autoInitAttempts < MAX_AUTO_INIT_ATTEMPTS) {
        // Retry if container not found yet (might be loading asynchronously)
        setTimeout(autoInit, 100);
      } else {
        console.error('[VisorAIWidget] Container not found after', MAX_AUTO_INIT_ATTEMPTS, 'attempts. Make sure the widget div exists in the DOM.');
      }
      return;
    }
    
    if (container.hasAttribute('data-widget-initialized')) return;

    // Extract configuration from data attributes
    const dataBaseUrl = container.getAttribute('data-base-url') || container.getAttribute('data-api-base');
    const dataAdmin = container.getAttribute('data-admin');
    const dataToken = container.getAttribute('data-token') || container.getAttribute('data-admin-token');
    const dataThemeColor = container.getAttribute('data-theme-color');
    const dataAccentColor = container.getAttribute('data-accent-color');
    const mode = dataAdmin === 'true' ? 'admin' : 'user';
    const selector = container.id ? `#${container.id}` : '#visor-ai-widget';
    
    // Initialize with extracted values
    // Note: init() will mark as initialized AFTER successful React rendering
    try {
      init({
        selector: selector,
        baseUrl: dataBaseUrl,
        themeColor: dataThemeColor,
        accentColor: dataAccentColor,
        mode: mode,
        adminToken: dataToken
      });
    } catch (error) {
      console.error('[VisorAIWidget] Error during initialization:', error);
    }
  }

  autoInit();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      autoInitAttempts = 0;
      autoInit();
    });
  }

  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => {
      const container = document.querySelector('#visor-ai-widget, [data-base-url], [data-api-base]');
      if (container && !container.hasAttribute('data-widget-initialized')) {
        autoInitAttempts = 0;
        autoInit();
      }
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      const bodyObserver = new MutationObserver(() => {
        if (document.body) {
          observer.observe(document.body, { childList: true, subtree: true });
          bodyObserver.disconnect();
        }
      });
      bodyObserver.observe(document.documentElement, { childList: true });
    }
  }

  window.addEventListener('load', () => {
    const container = document.querySelector('#visor-ai-widget, [data-base-url], [data-api-base]');
    if (container && !container.hasAttribute('data-widget-initialized')) {
      autoInitAttempts = 0;
      autoInit();
    }
  });
}

export default VisorAIWidget;
