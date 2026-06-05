import React, { useEffect, useState } from 'react';

/**
 * ConversationModal — fetches a single conversation by UUID and displays the
 * full transcript with per-message feedback. Closes via backdrop click, Esc,
 * or the explicit X button.
 */
export default function ConversationModal({ conversationId, get, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      const result = await get(`/api/admin/conversations/${conversationId}`);
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(`Failed to load: ${result.error}`);
        return;
      }
      setDetail(result.data);
    }
    load();
    return () => { cancelled = true; };
  }, [conversationId, get]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const formatDate = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('en-GB'); } catch { return iso; }
  };

  return (
    <div className="admin-modal-backdrop" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <div>
            <h3 className="admin-modal-title">Conversation Transcript</h3>
            {detail?.conversation && (
              <div className="admin-modal-meta">
                <code>{detail.conversation.conversation_id}</code>
                <span> · {detail.conversation.language || 'unknown'} · </span>
                <span>{formatDate(detail.conversation.started_at)}</span>
                <span> · {detail.messages?.length || 0} messages</span>
              </div>
            )}
          </div>
          <button
            type="button"
            className="admin-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="admin-modal-body">
          {loading && <p className="admin-status">Loading…</p>}
          {error && <p className="admin-error">{error}</p>}

          {detail && detail.messages && (
            <div className="admin-messages">
              {detail.messages.map((m) => (
                <div key={m.id} className={`admin-message ${m.role}`}>
                  <div className="admin-message-header">
                    <span className="admin-message-role">
                      {m.role === 'user' ? '👤 User' : '🤖 Assistant'}
                    </span>
                    <span className="admin-message-meta">
                      {formatDate(m.created_at)}
                      {m.path && <span> · {m.path}</span>}
                      {m.latency_ms != null && <span> · {m.latency_ms}ms</span>}
                    </span>
                  </div>
                  <div className="admin-message-content">{m.content}</div>
                  {m.feedback && (
                    <div className={`admin-message-feedback ${m.feedback.rating}`}>
                      <span className="admin-feedback-emoji">
                        {m.feedback.rating === 'up' ? '👍' : '👎'}
                      </span>
                      {m.feedback.tags && m.feedback.tags.length > 0 && (
                        <span className="admin-feedback-tags">
                          {m.feedback.tags.map((t) => (
                            <span key={t} className="admin-feedback-tag">{t}</span>
                          ))}
                        </span>
                      )}
                      {m.feedback.comment && (
                        <span className="admin-feedback-comment">"{m.feedback.comment}"</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
