/**
 * Session Memory Cache
 * Stores temporary user context (order_id, email) by conversationId
 */

class SessionCache {
  constructor() {
    // In-memory Map to store sessions
    // Key: conversationId, Value: { order_id, email, lastAccessed }
    this.sessions = new Map();
    
    // Cleanup interval: remove sessions older than 1 hour
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60 * 60 * 1000); // 1 hour
  }

  /**
   * Get session data for a conversationId
   * @param {string} conversationId - Unique conversation identifier
   * @returns {Object|null} - Session data or null if not found
   */
  get(conversationId) {
    if (!conversationId) return null;
    
    const session = this.sessions.get(conversationId);
    if (session) {
      session.lastAccessed = Date.now();
      return {
        order_id: session.order_id,
        email: session.email
      };
    }
    return null;
  }

  /**
   * Set session data for a conversationId
   * @param {string} conversationId - Unique conversation identifier
   * @param {Object} data - Session data { order_id?, email? }
   */
  set(conversationId, data) {
    if (!conversationId) return;
    
    const existing = this.sessions.get(conversationId) || {};
    this.sessions.set(conversationId, {
      order_id: data.order_id || existing.order_id || null,
      email: data.email || existing.email || null,
      lastAccessed: Date.now()
    });
  }

  /**
   * Update specific fields in session
   * @param {string} conversationId - Unique conversation identifier
   * @param {Object} updates - Fields to update { order_id?, email? }
   */
  update(conversationId, updates) {
    if (!conversationId) return;
    
    const existing = this.get(conversationId) || {};
    this.set(conversationId, {
      order_id: updates.order_id !== undefined ? updates.order_id : existing.order_id,
      email: updates.email !== undefined ? updates.email : existing.email
    });
  }

  /**
   * Clear session data
   * @param {string} conversationId - Unique conversation identifier
   */
  clear(conversationId) {
    if (conversationId) {
      this.sessions.delete(conversationId);
    }
  }

  /**
   * Cleanup old sessions (older than 1 hour)
   */
  cleanup() {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour
    
    for (const [conversationId, session] of this.sessions.entries()) {
      if (now - session.lastAccessed > maxAge) {
        this.sessions.delete(conversationId);
      }
    }
  }

  /**
   * Get all active sessions (for debugging/admin purposes)
   * @returns {Object} - Map of all sessions
   */
  getAll() {
    const result = {};
    for (const [id, session] of this.sessions.entries()) {
      result[id] = {
        order_id: session.order_id,
        email: session.email,
        lastAccessed: new Date(session.lastAccessed).toISOString()
      };
    }
    return result;
  }

  /**
   * Destroy cleanup interval (call on server shutdown)
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Singleton instance
const sessionCache = new SessionCache();

/**
 * Middleware to attach session management to request
 * Extracts conversationId from headers or body, manages session data
 */
function sessionMiddleware(req, res, next) {
  // Extract conversationId from headers or body
  const conversationId = req.headers['x-conversation-id'] || 
                         req.body?.conversationId || 
                         req.query?.conversationId ||
                         null;

  // Attach session methods to request object
  req.session = {
    getId: () => conversationId,
    get: () => sessionCache.get(conversationId),
    set: (data) => sessionCache.set(conversationId, data),
    update: (updates) => sessionCache.update(conversationId, updates),
    clear: () => sessionCache.clear(conversationId)
  };

  // Attach conversationId to request for easy access
  req.conversationId = conversationId;

  next();
}

module.exports = {
  sessionMiddleware,
  sessionCache
};
