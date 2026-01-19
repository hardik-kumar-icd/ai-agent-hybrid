/**
 * Security Logger
 * Masks sensitive information (emails, order IDs) in logs
 */

/**
 * Mask email address
 * Example: "user@example.com" → "u***@example.com"
 * @param {string} email - Email address to mask
 * @returns {string} - Masked email
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '***';
  
  const parts = email.split('@');
  if (parts.length !== 2) return '***';
  
  const [localPart, domain] = parts;
  if (localPart.length === 0) return `***@${domain}`;
  
  // Show first character, mask the rest
  const maskedLocal = localPart[0] + '*'.repeat(Math.min(localPart.length - 1, 3));
  return `${maskedLocal}@${domain}`;
}

/**
 * Mask order ID
 * Example: "12345" → "****5", "V-9901" → "V-***1"
 * @param {string} orderId - Order ID to mask
 * @returns {string} - Masked order ID
 */
function maskOrderId(orderId) {
  if (!orderId || typeof orderId !== 'string') return '****';
  
  const trimmed = orderId.trim();
  if (trimmed.length === 0) return '****';
  
  // Show last 2 characters, mask the rest
  if (trimmed.length <= 2) {
    return '*'.repeat(trimmed.length);
  }
  
  const visibleChars = Math.min(2, trimmed.length);
  const masked = '*'.repeat(Math.max(trimmed.length - visibleChars, 0));
  const visible = trimmed.slice(-visibleChars);
  
  return masked + visible;
}

/**
 * Mask any string (generic masking)
 * @param {string} value - Value to mask
 * @param {number} visibleChars - Number of characters to show at the end
 * @returns {string} - Masked value
 */
function maskString(value, visibleChars = 2) {
  if (!value || typeof value !== 'string') return '***';
  
  const trimmed = value.trim();
  if (trimmed.length <= visibleChars) {
    return '*'.repeat(trimmed.length);
  }
  
  const masked = '*'.repeat(Math.max(trimmed.length - visibleChars, 0));
  const visible = trimmed.slice(-visibleChars);
  
  return masked + visible;
}

/**
 * Log order lookup with masked sensitive data
 * @param {string} orderId - Order ID
 * @param {string} email - Email address
 * @param {string} action - Action description (optional)
 */
function logOrderLookup(orderId, email, action = 'Order lookup') {
  const maskedOrderId = maskOrderId(orderId);
  const maskedEmail = maskEmail(email);
  console.log(`${action} for ID: ${maskedOrderId}, email: ${maskedEmail}`);
}

/**
 * Log API request with masked sensitive data
 * @param {Object} req - Express request object
 * @param {string} endpoint - Endpoint name
 */
function logApiRequest(req, endpoint) {
  const orderId = req.body?.order_id || req.query?.order_id;
  const email = req.body?.email || req.query?.email;
  
  let logMessage = `API Request: ${endpoint}`;
  
  if (orderId) {
    logMessage += `, Order ID: ${maskOrderId(orderId)}`;
  }
  
  if (email) {
    logMessage += `, Email: ${maskEmail(email)}`;
  }
  
  console.log(logMessage);
}

module.exports = {
  maskEmail,
  maskOrderId,
  maskString,
  logOrderLookup,
  logApiRequest
};
