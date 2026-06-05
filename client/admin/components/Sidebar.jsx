import React from 'react';

/**
 * Sidebar — left navigation rail with section buttons and the admin token
 * input. Token sits at the bottom so it's always accessible (and rotating
 * it doesn't require navigating away from whatever section you're in).
 */
export default function Sidebar({
  activeSection,
  onSectionChange,
  token,
  onTokenChange,
  overviewStats,
}) {
  const sections = [
    { id: 'overview',      label: 'Overview',          icon: '📊' },
    { id: 'conversations', label: 'Conversations',     icon: '💬' },
    { id: 'feedback',      label: 'Feedback',          icon: '👍' },
    { id: 'knowledge',     label: 'Knowledge Base',    icon: '📁' },
    { id: 'diagnostics',   label: 'Diagnostics',       icon: '🔧' },
  ];

  return (
    <aside className="admin-sidebar">
      <div className="admin-sidebar-header">
        <h1 className="admin-sidebar-title">Visor AI</h1>
        <p className="admin-sidebar-subtitle">Admin Dashboard</p>
      </div>

      <nav className="admin-sidebar-nav">
        {sections.map((s) => {
          const badge =
            s.id === 'feedback' && overviewStats?.thumbs_down > 0
              ? overviewStats.thumbs_down
              : null;
          return (
            <button
              key={s.id}
              type="button"
              className={`admin-sidebar-link ${activeSection === s.id ? 'active' : ''}`}
              onClick={() => onSectionChange(s.id)}
            >
              <span className="admin-sidebar-icon" aria-hidden="true">{s.icon}</span>
              <span className="admin-sidebar-label">{s.label}</span>
              {badge !== null && (
                <span className="admin-sidebar-badge" title="Thumbs-down feedback waiting for review">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="admin-sidebar-token">
        <label htmlFor="sidebar-admin-token" className="admin-sidebar-token-label">
          Admin Token
        </label>
        <input
          id="sidebar-admin-token"
          type="password"
          className="admin-input"
          placeholder="ADMIN_API_KEY"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          autoComplete="off"
        />
        <p className="admin-sidebar-token-help">
          Kept in memory only. Never persisted.
        </p>
      </div>
    </aside>
  );
}
