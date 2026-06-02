/**
 * orderResponseFormatter.js
 *
 * Helpers for the direct-dispatch order-status path:
 *   - Format Magento order data into a friendly Norwegian customer-facing message
 *   - Format errors (not-found, email-mismatch, system) into matching Norwegian messages
 *   - Stream a string token-by-token via SSE so the customer sees gradual output
 *     matching the LLM streaming experience
 *
 * Used only by the route-level direct dispatch in visorChatStreamRoute.js when:
 *   - category === 'order'
 *   - order_id AND email are both present
 *
 * For free-text order questions (no widget category), the existing LLM-driven tool
 * dispatch path is used (with the new 'order' hint added in visorAgentShared.js).
 */

const CUSTOMER_SERVICE_EMAIL = 'kundeservice@visor.no';

// Magento order status codes → friendly Norwegian labels.
// Codes from a standard Magento 2 install. Unknown codes pass through raw.
const STATUS_LABELS_NO = {
  pending: 'Venter på behandling',
  pending_payment: 'Venter på betaling',
  processing: 'Behandles',
  complete: 'Fullført',
  closed: 'Lukket',
  canceled: 'Kansellert',
  holded: 'På vent',
  payment_review: 'Betaling under vurdering',
  fraud: 'Krever manuell sjekk',
  pending_paypal: 'Venter på PayPal',
};

function friendlyStatusNorwegian(status) {
  if (!status) return 'Ukjent';
  const key = String(status).toLowerCase().trim();
  return STATUS_LABELS_NO[key] || status;
}

/**
 * Build a Norwegian customer-facing message for a successful order lookup.
 * Tone: warm, factual, no over-explaining. Mirror the agent's normal voice.
 *
 * @param {{ id: string, status: string, tracking: string|null, delivery_date: string|null }} orderData
 * @returns {string} multi-line Norwegian message
 */
function formatOrderStatusNorwegian(orderData) {
  const id = orderData.id || 'ukjent';
  const statusLabel = friendlyStatusNorwegian(orderData.status);
  const tracking = orderData.tracking;
  const deliveryDate = orderData.delivery_date;

  const lines = [];
  lines.push(`Status på ordre #${id}: ${statusLabel}.`);

  if (tracking) {
    lines.push(`Sporingsnummer: ${tracking}.`);
  }

  if (deliveryDate) {
    lines.push(`Forventet levering: ${deliveryDate}.`);
  }

  // Closing line — varies by status
  const key = String(orderData.status || '').toLowerCase();
  if (key === 'complete') {
    lines.push('Ordren er ferdig behandlet og sendt.');
  } else if (key === 'processing') {
    lines.push('Vi jobber med ordren din nå.');
  } else if (key === 'pending' || key === 'pending_payment') {
    lines.push('Ordren venter på neste steg i prosessen.');
  } else if (key === 'canceled' || key === 'closed') {
    lines.push(`Ta kontakt med ${CUSTOMER_SERVICE_EMAIL} hvis du har spørsmål om denne ordren.`);
  }

  return lines.join('\n\n');
}

/**
 * Build a Norwegian error message for a failed order lookup.
 * Distinguishes between order-not-found, email-mismatch, and system errors.
 *
 * @param {Error} err - the error thrown by getOrderStatusTool
 * @returns {string} Norwegian error message
 */
function formatOrderErrorNorwegian(err) {
  const msg = String(err?.message || '');

  // Email mismatch (security-sensitive — DO NOT leak whether the order exists)
  if (msg.includes('Email does not match')) {
    return [
      'Vi kunne ikke bekrefte ordren med den informasjonen.',
      'Vennligst kontroller at både ordrenummer og e-postadresse er korrekt.',
      `Hvis problemet vedvarer, ta kontakt med oss på ${CUSTOMER_SERVICE_EMAIL}.`,
    ].join('\n\n');
  }

  // "Beklager" prefix means the tool already produced a customer-friendly message.
  // It comes from the tool's own error paths (404, 401, no items, etc.)
  if (msg.includes('Beklager')) {
    return msg;
  }

  // Generic system error — never leak internals
  return [
    'Vi kunne ikke hente ordrestatus akkurat nå.',
    `Vennligst prøv igjen om et øyeblikk, eller ta kontakt med ${CUSTOMER_SERVICE_EMAIL} for hjelp.`,
  ].join('\n\n');
}

/**
 * Stream a complete message token-by-token via SSE, matching the cadence of
 * LLM streaming so the customer doesn't see a sudden response after waiting.
 *
 * @param {object} res - Express response object
 * @param {string} text - the complete message to stream
 * @param {function} sendSse - callback to send an SSE event
 * @param {function} flush - callback to flush the response buffer
 * @param {object} [opts]
 * @param {number} [opts.delayMs=20] - delay between tokens in milliseconds
 * @param {number} [opts.chunkSize=3] - characters per emitted token
 */
async function streamTextAsTokens(res, text, sendSse, flush, opts = {}) {
  const delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : 20;
  const chunkSize = typeof opts.chunkSize === 'number' ? opts.chunkSize : 3;

  // Split into small chunks to look like real LLM token output.
  // We don't try to be clever about word boundaries — small character chunks
  // (3 chars) produces a smooth perceived streaming effect that matches gpt-4o.
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    sendSse(res, { type: 'token', content: chunk });
    flush(res);
    if (delayMs > 0 && i + chunkSize < text.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

module.exports = {
  formatOrderStatusNorwegian,
  formatOrderErrorNorwegian,
  streamTextAsTokens,
  friendlyStatusNorwegian,  // exported for testing
};
