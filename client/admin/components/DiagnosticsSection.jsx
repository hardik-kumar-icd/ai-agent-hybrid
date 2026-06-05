import React, { useState } from 'react';

/**
 * DiagnosticsSection — verify environment integrations + run a test semantic
 * search query against the Pinecone index. Extracted from the original
 * AdminDashboard.jsx.
 */
export default function DiagnosticsSection({ request, hasToken }) {
  const [actionLoading, setActionLoading] = useState(false);
  const [actionResponse, setActionResponse] = useState(null);
  const [actionError, setActionError] = useState('');
  const [activeAction, setActiveAction] = useState('');
  const [testQuery, setTestQuery] = useState('What products do you have?');

  const normalizeBody = (data) => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  const runAction = async (label, method, url, options = {}) => {
    if (!hasToken) {
      setActionError('Admin token is required. Paste your ADMIN_API_KEY in the sidebar.');
      return;
    }
    setActiveAction(label);
    setActionLoading(true);
    setActionError('');
    setActionResponse(null);

    const result = await request(method, url, options);
    setActionLoading(false);

    if (!result.ok) {
      setActionError(
        `Request failed${result.status ? ` (HTTP ${result.status})` : ''}: ${result.error}`
      );
      return;
    }
    setActionResponse({
      label,
      status: result.status,
      body: normalizeBody(result.data),
    });
  };

  const handleVerifyEnv = () => runAction('Verify Environment', 'get', '/api/verify-env');
  const handleTestSearch = () => {
    const params = testQuery ? { params: { q: testQuery } } : {};
    runAction('Test Search', 'get', '/api/pinecone/test-search', params);
  };

  return (
    <div className="admin-section">
      <h2 className="admin-section-title">Diagnostics</h2>
      <p className="admin-section-subtitle">
        Verify environment integrations and run test queries against the knowledge base.
      </p>

      <div className="admin-card">
        <h3>Environment</h3>
        <p className="admin-help">
          Hits <code>GET /api/verify-env</code> to check OpenAI, Pinecone, Postgres,
          and Magento connectivity.
        </p>
        <button
          className="admin-button"
          onClick={handleVerifyEnv}
          disabled={actionLoading}
        >
          ✅ Verify Environment
        </button>
      </div>

      <div className="admin-card">
        <h3>Test Search</h3>
        <p className="admin-help">
          Run a semantic search query against Pinecone to inspect the top-k
          retrieved chunks and their scores.
        </p>
        <div className="admin-test-search">
          <label htmlFor="test-search-input">Query</label>
          <input
            id="test-search-input"
            type="text"
            className="admin-input"
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            placeholder="What products do you have?"
          />
          <button
            className="admin-button"
            onClick={handleTestSearch}
            disabled={actionLoading}
          >
            🔍 Test Search
          </button>
        </div>
      </div>

      {(actionLoading || actionError || actionResponse) && (
        <div className="admin-card">
          <h3>Last Result</h3>
          {activeAction && (
            <p className="admin-active-action">
              Last action: <strong>{activeAction}</strong>
            </p>
          )}
          {actionLoading && <p className="admin-status">Running request…</p>}
          {actionError && <p className="admin-error">{actionError}</p>}
          {actionResponse && (
            <div className="admin-response">
              <div className="admin-response-header">
                <span className="admin-response-label">{actionResponse.label}</span>
                <span className="admin-response-status">HTTP {actionResponse.status}</span>
              </div>
              <pre className="admin-response-body">{actionResponse.body}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
