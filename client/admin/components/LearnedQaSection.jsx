import React, { useCallback, useEffect, useState } from 'react';

/**
 * LearnedQaSection — review the agent's learned Q&A candidates (Drop 2 episodic
 * memory). A 👍 promotes a pending candidate; an admin curates and approves it
 * here before it can go live in retrieval.
 *
 * Per candidate:
 *   - edit question + answer (PATCH clears the embedding so the embed worker
 *     re-embeds the curated text)
 *   - approve  → eligible to go live (after the embed worker runs)
 *   - reject   → never surfaces
 */
export default function LearnedQaSection({ get, request, hasToken }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');

  const [edits, setEdits] = useState({});
  const [busyId, setBusyId] = useState(null);

  const seedEdits = (rows) => {
    const next = {};
    rows.forEach((r) => {
      next[r.id] = { question: r.question || '', answer: r.answer || '' };
    });
    return next;
  };

  const load = useCallback(
    async (resetOffset = false) => {
      if (!hasToken) return;
      const useOffset = resetOffset ? 0 : offset;
      setLoading(true);
      setError('');
      const result = await get('/api/admin/learned-qa', {
        status: statusFilter,
        limit,
        offset: useOffset,
      });
      setLoading(false);
      if (!result.ok) {
        setError(`Failed to load: ${result.error}`);
        return;
      }
      const rows = result.data.learned_qa || [];
      if (resetOffset) {
        setItems(rows);
        setOffset(0);
        setEdits(seedEdits(rows));
      } else {
        setItems((prev) => [...prev, ...rows]);
        setEdits((prev) => ({ ...prev, ...seedEdits(rows) }));
      }
      setTotal(result.data.total);
    },
    [get, hasToken, offset, limit, statusFilter]
  );

  useEffect(() => {
    if (hasToken) load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken, statusFilter]);

  const handleLoadMore = async () => {
    const nextOffset = offset + limit;
    setOffset(nextOffset);
    setLoading(true);
    const result = await get('/api/admin/learned-qa', {
      status: statusFilter,
      limit,
      offset: nextOffset,
    });
    setLoading(false);
    if (!result.ok) {
      setError(`Failed to load more: ${result.error}`);
      return;
    }
    const rows = result.data.learned_qa || [];
    setItems((prev) => [...prev, ...rows]);
    setEdits((prev) => ({ ...prev, ...seedEdits(rows) }));
  };

  const onEditChange = (id, field, value) => {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const applyRow = (row) => {
    if (!row) return;
    setItems((prev) => prev.map((it) => (it.id === row.id ? row : it)));
    setEdits((prev) => ({
      ...prev,
      [row.id]: { question: row.question || '', answer: row.answer || '' },
    }));
  };

  const removeRow = (id) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    setTotal((t) => Math.max(0, t - 1));
  };

  const saveEdit = async (id) => {
    const edit = edits[id] || {};
    setBusyId(id);
    setError('');
    const result = await request('PATCH', `/api/admin/learned-qa/${id}`, {
      data: { question: edit.question, answer: edit.answer },
    });
    setBusyId(null);
    if (!result.ok) {
      setError(`Save failed: ${result.error}`);
      return;
    }
    applyRow(result.data.learned_qa);
  };

  const decide = async (id, decision) => {
    setBusyId(id);
    setError('');
    const result = await request('POST', `/api/admin/learned-qa/${id}/${decision}`, {
      data: {},
    });
    setBusyId(null);
    if (!result.ok) {
      setError(`${decision} failed: ${result.error}`);
      return;
    }
    const row = result.data.learned_qa;
    if (row && row.status !== statusFilter) {
      removeRow(id);
    } else {
      applyRow(row);
    }
  };

  const formatDate = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('en-GB'); } catch { return iso; }
  };

  if (!hasToken) {
    return (
      <div className="admin-section">
        <h2 className="admin-section-title">Learning</h2>
        <div className="admin-empty">
          <p>Paste your <code>ADMIN_API_KEY</code> in the sidebar to review learned answers.</p>
        </div>
      </div>
    );
  }

  const canLoadMore = items.length < total;

  return (
    <div className="admin-section">
      <div className="admin-section-row">
        <div>
          <h2 className="admin-section-title">Learning</h2>
          <p className="admin-section-subtitle">
            Showing {items.length} of {total} {statusFilter} candidate{total === 1 ? '' : 's'}.
            {statusFilter === 'pending' && ' Curate the question/answer, then approve to make it live.'}
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
              className={`admin-filter-tab ${statusFilter === 'pending' ? 'active' : ''}`}
              onClick={() => setStatusFilter('pending')}
            >
              Pending
            </button>
            <button
              type="button"
              className={`admin-filter-tab ${statusFilter === 'approved' ? 'active' : ''}`}
              onClick={() => setStatusFilter('approved')}
            >
              Approved
            </button>
            <button
              type="button"
              className={`admin-filter-tab ${statusFilter === 'rejected' ? 'active' : ''}`}
              onClick={() => setStatusFilter('rejected')}
            >
              Rejected
            </button>
          </div>
        </div>
      </div>

      {error && <p className="admin-error">{error}</p>}

      {items.length === 0 && !loading ? (
        <div className="admin-card">
          <p className="admin-empty-text">No {statusFilter} candidates.</p>
        </div>
      ) : (
        <div className="admin-learned-list">
          {items.map((item) => {
            const edit = edits[item.id] || { question: '', answer: '' };
            const busy = busyId === item.id;
            const dirty =
              edit.question !== (item.question || '') || edit.answer !== (item.answer || '');
            return (
              <div key={item.id} className="admin-learned-card">
                <div className="admin-learned-meta">
                  <span className={`admin-learned-pill ${item.status}`}>{item.status}</span>
                  {item.language && <span className="admin-learned-lang">{item.language}</span>}
                  <span className="admin-learned-embed">
                    {item.embedding_id ? '● embedded' : '○ not embedded'}
                  </span>
                  <span className="admin-learned-date">{formatDate(item.created_at)}</span>
                </div>

                <div className="admin-learned-field">
                  <label className="admin-learned-label">Question</label>
                  <textarea
                    className="admin-input admin-learned-textarea"
                    rows={2}
                    value={edit.question}
                    onChange={(e) => onEditChange(item.id, 'question', e.target.value)}
                    disabled={busy}
                  />
                </div>

                <div className="admin-learned-field">
                  <label className="admin-learned-label">Answer</label>
                  <textarea
                    className="admin-input admin-learned-textarea"
                    rows={4}
                    value={edit.answer}
                    onChange={(e) => onEditChange(item.id, 'answer', e.target.value)}
                    disabled={busy}
                  />
                </div>

                <div className="admin-learned-actions">
                  <button
                    className="admin-button"
                    onClick={() => saveEdit(item.id)}
                    disabled={busy || !dirty || !edit.question.trim() || !edit.answer.trim()}
                  >
                    {busy ? 'Saving…' : 'Save edits'}
                  </button>
                  <button
                    className="admin-button primary"
                    onClick={() => decide(item.id, 'approve')}
                    disabled={busy || item.status === 'approved'}
                  >
                    Approve
                  </button>
                  <button
                    className="admin-button danger"
                    onClick={() => decide(item.id, 'reject')}
                    disabled={busy || item.status === 'rejected'}
                  >
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
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
    </div>
  );
}