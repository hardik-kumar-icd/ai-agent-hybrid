import React, { useCallback, useEffect, useState } from 'react';
import ConversationModal from './ConversationModal';

/**
 * ConversationsSection — paginated list of conversations with filters.
 * Click a row to open the full transcript in a modal.
 */
export default function ConversationsSection({ get, hasToken }) {
  const [conversations, setConversations] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Filters
  const [filterHasFeedback, setFilterHasFeedback] = useState(false);
  const [filterRating, setFilterRating] = useState('');     // '', 'up', 'down'

  // Modal
  const [selectedConvId, setSelectedConvId] = useState(null);

  const load = useCallback(
    async (resetOffset = false) => {
      if (!hasToken) return;
      const useOffset = resetOffset ? 0 : offset;
      setLoading(true);
      setError('');
      const params = { limit, offset: useOffset };
      if (filterHasFeedback) {
        params.has_feedback = true;
        if (filterRating) params.rating = filterRating;
      }
      const result = await get('/api/admin/conversations', params);
      setLoading(false);
      if (!result.ok) {
        setError(`Failed to load: ${result.error}`);
        return;
      }
      if (resetOffset) {
        setConversations(result.data.conversations);
        setOffset(0);
      } else {
        setConversations(useOffset === 0
          ? result.data.conversations
          : (prev) => [...prev, ...result.data.conversations]
        );
      }
      setTotal(result.data.total);
    },
    [get, hasToken, offset, limit, filterHasFeedback, filterRating]
  );

  // Reload when filters change
  useEffect(() => {
    if (hasToken) load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken, filterHasFeedback, filterRating]);

  const handleLoadMore = async () => {
    const nextOffset = offset + limit;
    setOffset(nextOffset);
    setLoading(true);
    const params = { limit, offset: nextOffset };
    if (filterHasFeedback) {
      params.has_feedback = true;
      if (filterRating) params.rating = filterRating;
    }
    const result = await get('/api/admin/conversations', params);
    setLoading(false);
    if (!result.ok) {
      setError(`Failed to load more: ${result.error}`);
      return;
    }
    setConversations((prev) => [...prev, ...result.data.conversations]);
  };

  const formatDate = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString('en-GB', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  if (!hasToken) {
    return (
      <div className="admin-section">
        <h2 className="admin-section-title">Conversations</h2>
        <div className="admin-empty">
          <p>Paste your <code>ADMIN_API_KEY</code> in the sidebar to browse conversations.</p>
        </div>
      </div>
    );
  }

  const canLoadMore = conversations.length < total;

  return (
    <div className="admin-section">
      <div className="admin-section-row">
        <div>
          <h2 className="admin-section-title">Conversations</h2>
          <p className="admin-section-subtitle">
            Showing {conversations.length} of {total} conversation{total === 1 ? '' : 's'}.
            Click any row to view the full transcript.
          </p>
        </div>
        <button className="admin-button" onClick={() => load(true)} disabled={loading}>
          🔄 Refresh
        </button>
      </div>

      <div className="admin-card">
        <div className="admin-filter-row">
          <label className="admin-filter-checkbox">
            <input
              type="checkbox"
              checked={filterHasFeedback}
              onChange={(e) => setFilterHasFeedback(e.target.checked)}
            />
            <span>Only with feedback</span>
          </label>
          <div className="admin-filter-select">
            <label htmlFor="filter-rating">Rating</label>
            <select
              id="filter-rating"
              className="admin-input"
              value={filterRating}
              onChange={(e) => setFilterRating(e.target.value)}
              disabled={!filterHasFeedback}
            >
              <option value="">Any</option>
              <option value="up">👍 Up</option>
              <option value="down">👎 Down</option>
            </select>
          </div>
        </div>
      </div>

      {error && <p className="admin-error">{error}</p>}

      <div className="admin-card admin-table-card">
        {conversations.length === 0 && !loading ? (
          <p className="admin-empty-text">No conversations match the current filters.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Conversation</th>
                <th>Lang</th>
                <th>Messages</th>
                <th>Feedback</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr
                  key={c.id}
                  className="admin-table-row"
                  onClick={() => setSelectedConvId(c.id)}
                  title="Click to view full transcript"
                >
                  <td className="admin-table-date">{formatDate(c.started_at)}</td>
                  <td className="admin-table-id">
                    <code>{c.conversation_id?.slice(0, 28) || c.id.slice(0, 8)}…</code>
                  </td>
                  <td>{c.language || '—'}</td>
                  <td className="admin-table-num">{c.message_count}</td>
                  <td>
                    {c.feedback_up === 0 && c.feedback_down === 0 ? (
                      <span className="admin-feedback-pill none">—</span>
                    ) : (
                      <>
                        {c.feedback_up > 0 && (
                          <span className="admin-feedback-pill up">👍 {c.feedback_up}</span>
                        )}
                        {c.feedback_down > 0 && (
                          <span className="admin-feedback-pill down">👎 {c.feedback_down}</span>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {loading && <p className="admin-status">Loading…</p>}

        {canLoadMore && !loading && (
          <div className="admin-load-more">
            <button className="admin-button" onClick={handleLoadMore}>
              Load more ({total - conversations.length} remaining)
            </button>
          </div>
        )}
      </div>

      {selectedConvId && (
        <ConversationModal
          conversationId={selectedConvId}
          get={get}
          onClose={() => setSelectedConvId(null)}
        />
      )}
    </div>
  );
}
