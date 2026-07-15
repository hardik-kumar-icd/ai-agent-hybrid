import React, { useCallback, useEffect, useState } from 'react';
import ConversationModal from './ConversationModal';

const SOURCE_LABELS = {
  visor_faqs: 'FAQ',
  visor_products: 'Product catalog',
  visor_tickets: 'Support ticket history',
  'tickets_fixed.jsonl': 'Support ticket history',
  learned_qa: 'Learned answers',
};

/**
 * UnansweredSection — the ground-truth "what are customers asking that we
 * have no good answer for" view. Every RAG lookup that failed every source's
 * confidence floor is logged to the `retrievals` table (has been since
 * Drop 4-light) but was never surfaced anywhere until now. Grouped by the
 * recurring question so the same failure asked many times shows up as one
 * row with an occurrence count, instead of being buried among individually
 * timestamped rows.
 */
export default function UnansweredSection({ get, hasToken }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sinceFilter, setSinceFilter] = useState('30'); // days, '' = all-time
  const [openConvId, setOpenConvId] = useState(null);

  const load = useCallback(async () => {
    if (!hasToken) return;
    setLoading(true);
    setError('');
    const params = { limit: 50 };
    if (sinceFilter) {
      const since = new Date(Date.now() - Number(sinceFilter) * 24 * 60 * 60 * 1000);
      params.since = since.toISOString();
    }
    const result = await get('/api/admin/retrievals/unanswered', params);
    setLoading(false);
    if (!result.ok) {
      setError(`Failed to load: ${result.error}`);
      return;
    }
    setItems(result.data.unanswered || []);
  }, [get, hasToken, sinceFilter]);

  useEffect(() => {
    if (hasToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken, sinceFilter]);

  const formatDate = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('en-GB'); } catch { return iso; }
  };

  const formatScore = (row) => {
    const score = row.avg_score != null ? Number(row.avg_score).toFixed(2) : '—';
    const floor = row.floor != null ? Number(row.floor).toFixed(2) : '—';
    return `${score} (floor ${floor})`;
  };

  if (!hasToken) {
    return (
      <div className="admin-section">
        <h2 className="admin-section-title">Unanswered Questions</h2>
        <div className="admin-empty">
          <p>Paste your <code>ADMIN_API_KEY</code> in the sidebar to view unanswered questions.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-section">
      <div className="admin-section-row">
        <div>
          <h2 className="admin-section-title">Unanswered Questions</h2>
          <p className="admin-section-subtitle">
            Real customer queries that failed every knowledge source's confidence floor —
            the direct signal for what to improve next, grouped by recurring question.
          </p>
        </div>
        <button className="admin-button" onClick={load} disabled={loading}>
          🔄 Refresh
        </button>
      </div>

      <div className="admin-card">
        <div className="admin-filter-row">
          <div className="admin-filter-tabs">
            <button
              type="button"
              className={`admin-filter-tab ${sinceFilter === '7' ? 'active' : ''}`}
              onClick={() => setSinceFilter('7')}
            >
              Last 7 days
            </button>
            <button
              type="button"
              className={`admin-filter-tab ${sinceFilter === '30' ? 'active' : ''}`}
              onClick={() => setSinceFilter('30')}
            >
              Last 30 days
            </button>
            <button
              type="button"
              className={`admin-filter-tab ${sinceFilter === '' ? 'active' : ''}`}
              onClick={() => setSinceFilter('')}
            >
              All time
            </button>
          </div>
        </div>
      </div>

      {error && <p className="admin-error">{error}</p>}

      {items.length === 0 && !loading ? (
        <div className="admin-card">
          <p className="admin-empty-text">
            No unanswered queries in this window — either genuinely good coverage, or not enough traffic yet.
          </p>
        </div>
      ) : (
        <div className="admin-feedback-list">
          {items.map((row) => (
            <div key={`${row.source}:${row.query}`} className="admin-feedback-card down">
              <div className="admin-feedback-header">
                <div>
                  <span className="admin-feedback-tag">
                    {SOURCE_LABELS[row.source] || row.source}
                  </span>
                  <span className="admin-feedback-date">
                    {' '}asked {row.occurrences}× · last {formatDate(row.last_seen)}
                  </span>
                </div>
                {row.latest_conversation_id && (
                  <button
                    type="button"
                    className="admin-button"
                    onClick={() => setOpenConvId(row.latest_conversation_id)}
                  >
                    View latest conversation
                  </button>
                )}
              </div>

              <div className="admin-feedback-block user">
                <div className="admin-feedback-block-label">Query</div>
                <div className="admin-feedback-block-content">{row.query}</div>
              </div>

              <div className="admin-feedback-block reason">
                <div className="admin-feedback-block-label">Best match score</div>
                <div className="admin-feedback-comment-text">{formatScore(row)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {loading && <p className="admin-status">Loading…</p>}

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
