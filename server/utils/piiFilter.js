/**
 * PII Filter Utility
 * Sanitizes order data to remove PII, price, and address information
 * Returns only: id, status, tracking, delivery_date
 */

/**
 * Sanitize order data to remove PII and sensitive information
 * @param {Object} order - Order object from any source
 * @returns {Object} - Sanitized order with only: id, status, tracking, delivery_date
 */
function sanitizeOrderData(order) {
  return {
    id: order.id || order.increment_id || order.order_id || null,
    status: order.status || 'unknown',
    tracking: order.tracking || order.tracking_number || null,
    delivery_date: order.delivery_date || null
  };
}

module.exports = { sanitizeOrderData };
