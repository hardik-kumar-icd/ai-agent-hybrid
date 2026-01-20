/**
 * Rate Limiter Middleware
 * Prevents excessive requests and protects the server
 */

const rateLimit = require('express-rate-limit');

/**
 * Global Rate Limiter
 * Limits each IP to 60 requests per minute
 */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 requests per windowMs
  message: {
    error: 'Too many requests, please try again later.',
    retry_after: 0
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Skip trust proxy validation - trust proxy is set in server.js
  validate: {
    trustProxy: false
  },
  handler: (req, res) => {
    // Calculate retry_after in seconds
    // req.rateLimit.resetTime is the timestamp when the rate limit will reset
    const resetTime = req.rateLimit?.resetTime || Date.now() + (60 * 1000);
    const retryAfter = Math.max(0, Math.ceil((resetTime - Date.now()) / 1000));
    
    res.status(429).json({
      error: 'Too many requests, please try again later.',
      retry_after: retryAfter
    });
  }
});

/**
 * Ingest Rate Limiter
 * Limits each IP to 10 requests per minute for file ingestion
 */
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    error: 'Too many requests, please try again later.',
    retry_after: 0
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Skip trust proxy validation - trust proxy is set in server.js
  validate: {
    trustProxy: false
  },
  handler: (req, res) => {
    // Calculate retry_after in seconds
    // req.rateLimit.resetTime is the timestamp when the rate limit will reset
    const resetTime = req.rateLimit?.resetTime || Date.now() + (60 * 1000);
    const retryAfter = Math.max(0, Math.ceil((resetTime - Date.now()) / 1000));
    
    res.status(429).json({
      error: 'Too many requests, please try again later.',
      retry_after: retryAfter
    });
  }
});

module.exports = {
  globalLimiter,
  ingestLimiter
};
