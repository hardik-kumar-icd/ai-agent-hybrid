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

// Order status codes → customer-facing Norwegian labels.
// Source: Visor's Magento Stores → Settings → Order Status (2026-06-02).
// Codes are CASE-SENSITIVE in Magento. We normalize by lowercasing the
// lookup key and storing all keys lowercase here.
const STATUS_LABELS_NO = {
  // ---- Standard Magento statuses ----
  pending: 'Pending',
  pending_payment: 'Pending Payment',
  pending_paypal: 'Pending PayPal',
  payment_review: 'Payment Review',
  processing: 'Sendt produksjon',
  holded: 'On Hold',
  complete: 'Ventende forsendelse',
  closed: 'Slettet',
  canceled: 'Canceled',
  fraud: 'Suspected Fraud',
  paypal_reversed: 'PayPal Reversed',
  paypal_canceled_reversal: 'PayPal Canceled Reversal',
  dintero_pending_approval: 'Dintero Pending Approval',

  // ---- Visor custom production-workflow statuses ----
  produseres_ds: 'Produseres DS',
  produseres_dm: 'Produseres DM',
  produseres_dl: 'Produseres DL',
  produseres_ks: 'Produseres KS',
  produseres_ff: 'Produseres FF',
  produseres_na: 'Produseres NA',
  produseres_su: 'Produseres SU',
  produseres_ava: 'Produksjon Hentepakke',
  ventende_produksjon: 'Ventende produksjon',
  utsatt_sending: 'Kunde bedt om utsatt utgående',
  sendt_fra_fabrikken: 'Sendt fra fabrikken',
  overforing: 'Overføring',
  delivered: 'Levert',
  levert_2019: 'Levert 2019',
  levert_2018: 'Levert 2018',
};

function friendlyStatusNorwegian(status) {
  if (!status) return 'Ukjent';
  const key = String(status).toLowerCase().trim();
  if (STATUS_LABELS_NO[key]) return STATUS_LABELS_NO[key];
  // Fallback: humanize unknown codes (e.g. 'some_new_status' → 'Some New Status').
  // Better than dumping the raw code to the customer.
  return key
    .split('_')
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
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

  // Closing line — varies by status. Visor's semantics differ from stock Magento:
  // 'complete' means "Ventende forsendelse" (awaiting shipment), NOT "Fullført".
  // 'delivered' is the actual end state.
  const key = String(orderData.status || '').toLowerCase();
  if (key === 'delivered' || key === 'levert_2019' || key === 'levert_2018') {
    lines.push('Ordren er levert.');
  } else if (key === 'complete') {
    lines.push('Ordren er klar og venter på forsendelse.');
  } else if (key === 'sendt_fra_fabrikken') {
    lines.push('Ordren er sendt fra fabrikken og er på vei.');
  } else if (key.startsWith('produseres_') || key === 'ventende_produksjon') {
    lines.push('Vi jobber med ordren din.');
  } else if (key === 'processing') {
    lines.push('Ordren er sendt til produksjon.');
  } else if (key === 'pending' || key === 'pending_payment' || key === 'pending_paypal' || key === 'dintero_pending_approval') {
    lines.push('Ordren venter på neste steg i prosessen.');
  } else if (key === 'canceled' || key === 'closed') {
    lines.push(`Ta kontakt med ${CUSTOMER_SERVICE_EMAIL} hvis du har spørsmål om denne ordren.`);
  } else if (key === 'utsatt_sending') {
    lines.push('Sendingen er utsatt på forespørsel.');
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
