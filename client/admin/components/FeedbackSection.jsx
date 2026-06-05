import React, { useCallback, useEffect, useState } from 'react';
import ConversationModal from './ConversationModal';

/**
 * FeedbackSection — browse customer feedback. Defaults to thumbs-down (the
 * actionable signal) with a toggle to view all ratings.
 *
 * Each feedback row shows:
 *   - The previous user message (for context)
 *   - The assistant's answer that was rated
 *   - The rating, tags, and optional free-text comment
 *   - Click "View conversation" to open the full transcript
 */
export default function FeedbackSection({ get, hasToken }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ratingFilter, setRatingFilter] = useState('down');  // default: down

  const [openConvId, setOpenConvId] = useState(null);

  const load = useCallback(
    async (resetOffset = false) => {
      if (!hasToken) return;
      const useOffset = resetOffset ? 0 : offset;
      setLoading(true);
      setError('');
      const params = { limit, offset: useOffset };
      if (ratingFilter) params.rating = ratingFilter;
      const result = await get('/api/admin/feedback', params);
      setLoading(false);
      if (!result.ok) {
        setError(`Failed to load: ${result.error}`);
        return;
      }
      if (resetOffset) {
        setItems(result.data.feedback);
        setOffset(0);
      } else {
        setItems((prev) => [...prev, ...result.data.feedback]);
      }
      setTotal(result.data.total);
    },
    [get, hasToken, offset, limit, ratingFilter]
  );

  useEffect(() => {
    if (hasToken) load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken, ratingFilter]);

  const handleLoadMore = async () => {
    const nextOffset = offset + limit;
    setOffset(nextOffset);
    setLoading(true);
    const params = { limit, offset: nextOffset };
    if (ratingFilter) params.rating = ratingFilter;
    const result = await get('/api/admin/feedback', params);
    setLoading(false);
    if (!result.ok) {
      setError(`Failed to load more: ${result.error}`);
      return;
    }
    setItems((prev) => [...prev, ...result.data.feedback]);
  };

  const formatDate = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('en-GB'); } catch { return iso; }
  };

  if (!hasToken) {
    return (
      <div className="admin-section">
        <h2 className="admin-section-title">Feedback</h2>
        <div className="admin-empty">
          <p>Paste your <code>ADMIN_API_KEY</code> in the sidebar to view customer feedback.</p>
        </div>
      </div>
    );
  }

  const canLoadMore = items.length < total;

  return (
    <div className="admin-section">
      <div className="admin-section-row">
        <div>
          <h2 className="admin-section-title">Feedback</h2>
          <p className="admin-section-subtitle">
            Showing {items.length} of {total} feedback row{total === 1 ? '' : 's'}.
            {ratingFilter === 'down' && ' Thumbs-down first — these are the actionable cases.'}
          </p>
        </div>
        <button className="admin-button" onClick={() => load(true)} disabled={loading}>
          🔄 Refresh
        </button>
      </div>

      <div className="admin-card">
        <div className="admin-filter-row">
          <div className="admin-filter-tabs">
            <button
              type="button"
              className={`admin-filter-tab ${ratingFilter === 'down' ? 'active' : ''}`}
              onClick={() => setRatingFilter('down')}
            >
              👎 Thumbs Down
            </button>
            <button
              type="button"
              className={`admin-filter-tab ${ratingFilter === 'up' ? 'active' : ''}`}
              onClick={() => setRatingFilter('up')}
            >
              👍 Thumbs Up
            </button>
            <button
              type="button"
              className={`admin-filter-tab ${ratingFilter === '' ? 'active' : ''}`}
              onClick={() => setRatingFilter('')}
            >
              All
            </button>
          </div>
        </div>
      </div>

      {error && <p className="admin-error">{error}</p>}

      {items.length === 0 && !loading ? (
        <div className="admin-card">
          <p className="admin-empty-text">No feedback matches the current filter.</p>
        </div>
      ) : (
        <div className="admin-feedback-list">
          {items.map((f) => (
            <div key={f.message_id} className={`admin-feedback-card ${f.rating}`}>
              <div className="admin-feedback-header">
                <div>
                  <span className="admin-feedback-emoji-big">
                    {f.rating === 'up' ? '👍' : '👎'}
                  </span>
                  <span className="admin-feedback-date">{formatDate(f.updated_at)}</span>
                </div>
                <button
                  type="button"
                  className="admin-button"
                  onClick={() => setOpenConvId(f.conversation_id)}
                >
                  View conversation
                </button>
              </div>

              {f.prev_user_message && (
                <div className="admin-feedback-block user">
                  <div className="admin-feedback-block-label">User asked</div>
                  <div className="admin-feedback-block-content">
                    {f.prev_user_message.content}
                  </div>
                </div>
              )}

              <div className="admin-feedback-block assistant">
                <div className="admin-feedback-block-label">
                  Assistant answered
                  {f.message.path && <span> · {f.message.path}</span>}
                  {f.message.latency_ms != null && <span> · {f.message.latency_ms}ms</span>}
                </div>
                <div className="admin-feedback-block-content">
                  {f.message.content}
                </div>
              </div>

              {(f.tags && f.tags.length > 0) || f.comment ? (
                <div className="admin-feedback-block reason">
                  <div className="admin-feedback-block-label">Customer feedback</div>
                  {f.tags && f.tags.length > 0 && (
                    <div className="admin-feedback-tags-row">
                      {f.tags.map((t) => (
                        <span key={t} className="admin-feedback-tag">{t}</span>
                      ))}
                    </div>
                  )}
                  {f.comment && (
                    <div className="admin-feedback-comment-text">"{f.comment}"</div>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {loading && <p className="admin-status">Loading…</p>}

      {canLoadMore && !loading && (
        <div className="admin-load-more">
          <button className="admin-button" onClick={handleLoadMore}>
            Load more ({total - items.length} remaining)
          </button>
        </div>
      )}

      {openConvId && (
        <ConversationModal
          conversationId={openConvId}
          get={get}
          onClose={() => setOpenConvId(null)}
        />
      )}
    </div>
  );
}
