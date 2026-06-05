import React, { useEffect, useState } from 'react';

/**
 * OverviewSection — landing page when the admin opens the dashboard. Shows
 * top-level counts: conversations, messages, feedback breakdown.
 *
 * Auto-fetches when the token is set or when this section becomes active.
 */
export default function OverviewSection({ get, hasToken, stats: parentStats, refreshStats }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // If parent passed stats, use them; otherwise fetch our own
  const [localStats, setLocalStats] = useState(null);
  const stats = parentStats || localStats;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!hasToken) return;
      if (parentStats) return;  // parent owns the fetch
      setLoading(true);
      setError('');
      const result = await get('/api/admin/overview');
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(`Failed to load stats: ${result.error}`);
        return;
      }
      setLocalStats(result.data.stats);
    }
    load();
    return () => { cancelled = true; };
  }, [hasToken, parentStats, get]);

  if (!hasToken) {
    return (
      <div className="admin-section">
        <h2 className="admin-section-title">Overview</h2>
        <div className="admin-empty">
          <p>Paste your <code>ADMIN_API_KEY</code> in the sidebar to load the dashboard.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-section">
      <div className="admin-section-row">
        <div>
          <h2 className="admin-section-title">Overview</h2>
          <p className="admin-section-subtitle">
            Current data volume across the agent's tables.
          </p>
        </div>
        <button
          className="admin-button"
          onClick={() => (refreshStats ? refreshStats() : setLocalStats(null))}
          disabled={loading}
        >
          🔄 Refresh
        </button>
      </div>

      {loading && <p className="admin-status">Loading…</p>}
      {error && <p className="admin-error">{error}</p>}

      {stats && (
        <div className="admin-stats-grid">
          <div className="admin-stat-card">
            <div className="admin-stat-label">Conversations</div>
            <div className="admin-stat-value">{stats.conversations}</div>
          </div>
          <div className="admin-stat-card">
            <div className="admin-stat-label">Messages</div>
            <div className="admin-stat-value">{stats.messages}</div>
          </div>
          <div className="admin-stat-card">
            <div className="admin-stat-label">Feedback Total</div>
            <div className="admin-stat-value">{stats.feedback}</div>
          </div>
          <div className="admin-stat-card up">
            <div className="admin-stat-label">👍 Thumbs Up</div>
            <div className="admin-stat-value">{stats.thumbs_up}</div>
          </div>
          <div className="admin-stat-card down">
            <div className="admin-stat-label">👎 Thumbs Down</div>
            <div className="admin-stat-value">{stats.thumbs_down}</div>
          </div>
        </div>
      )}
    </div>
  );
}
