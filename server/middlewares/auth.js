/**
 * Authentication Middleware
 * Token-based authentication for admin routes
 */

const crypto = require('crypto');

/**
 * Constant-time string comparison to avoid leaking key length/content via
 * response-time differences.
 */
function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against a same-length dummy so the timing doesn't reveal
    // whether the length mismatch is the reason for failure.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware to verify admin API key from Authorization header
 * Expects: Authorization: Bearer <ADMIN_API_KEY>
 */
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  // Check if Authorization header exists
  if (!authHeader) {
    return res.status(401).json({
      error: 'Unauthorized: Invalid or missing token'
    });
  }

  // Extract token from "Bearer <token>" format
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      error: 'Unauthorized: Invalid or missing token'
    });
  }

  const token = parts[1];
  const adminApiKey = process.env.ADMIN_API_KEY;

  // Check if ADMIN_API_KEY is configured
  if (!adminApiKey) {
    console.error('ADMIN_API_KEY is not configured in environment variables');
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Server configuration error'
    });
  }

  // Verify token matches admin API key (constant-time to avoid timing side-channel)
  if (!timingSafeEqualStrings(token, adminApiKey)) {
    return res.status(401).json({
      error: 'Unauthorized: Invalid or missing token'
    });
  }

  // Token is valid, proceed to next middleware
  next();
}

module.exports = {
  requireAdminAuth
};
