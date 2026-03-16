import React, { useMemo, useState } from 'react';
import axios from 'axios';

/**
 * AdminDashboard
 *
 * Secure, in-browser admin dashboard for:
 * - Uploading knowledge base files to POST /api/ingest
 * - Running environment / Pinecone diagnostics
 *
 * IMPORTANT:
 * - The ADMIN_API_KEY is never stored in localStorage/sessionStorage/cookies.
 *   It only lives in React state for the lifetime of the page.
 */
function AdminDashboard() {
  const [token, setToken] = useState('');
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadLog, setUploadLog] = useState([]);

  const [actionLoading, setActionLoading] = useState(false);
  const [actionResponse, setActionResponse] = useState(null);
  const [actionError, setActionError] = useState('');
  const [activeAction, setActiveAction] = useState('');
  const [testQuery, setTestQuery] = useState('What products do you have?');

  const sanitizeToken = (raw) => {
    if (!raw) return '';
    let value = raw.trim();
    if (value.startsWith('REACT_APP_ADMIN_TOKEN=')) {
      value = value.replace(/^REACT_APP_ADMIN_TOKEN=/, '').trim();
    }
    if (value.startsWith('ADMIN_API_KEY=')) {
      value = value.replace(/^ADMIN_API_KEY=/, '').trim();
    }
    return value;
  };

  // Detect API base URL dynamically from the current origin.
  const apiClient = useMemo(() => {
    const origin =
      typeof window !== 'undefined' && window.location
        ? window.location.origin
        : '';

    return axios.create({
      baseURL: origin || undefined,
      timeout: 120000,
    });
  }, []);

  const requireToken = () => {
    const normalized = sanitizeToken(token);
    if (!normalized) {
      setActionError('Admin token is required. Paste your ADMIN_API_KEY from Render.');
      return false;
    }
    return true;
  };

  const handleFilesChange = (event) => {
    const selected = Array.from(event.target.files || []);
    setFiles(selected);
  };

  const appendUploadLog = (entry) => {
    setUploadLog((prev) => [...prev, { ...entry, id: Date.now() + Math.random() }].slice(-50));
  };

  const handleUpload = async () => {
    if (!requireToken()) {
      return;
    }

    if (!files.length) {
      appendUploadLog({ type: 'error', message: 'Please select at least one file.' });
      return;
    }

    setUploading(true);
    setActionError('');

    for (const file of files) {
      try {
        const normalizedToken = sanitizeToken(token);
        const formData = new FormData();
        formData.append('file', file);

        const response = await apiClient.post('/api/ingest', formData, {
          headers: {
            Authorization: `Bearer ${normalizedToken}`,
          },
        });

        appendUploadLog({
          type: 'success',
          message: `✓ ${file.name} uploaded (${Math.round(file.size / 1024)} KB)${
            response.data?.sourceName ? ` → ${response.data.sourceName}` : ''
          }`,
        });
      } catch (error) {
        // Normalize error message for log display
        const status = error.response?.status;
        const text = error.response?.data?.message || error.message || 'Upload failed';
        appendUploadLog({
          type: 'error',
          message: `✗ ${file.name} (${status || 'ERR'}): ${text}`,
        });
      }
    }

    setUploading(false);
  };

  const normalizeResponse = (data) => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  const handleAdminAction = async (label, method, url, options = {}) => {
    if (!requireToken()) {
      return;
    }

    setActiveAction(label);
    setActionLoading(true);
    setActionError('');
    setActionResponse(null);

    try {
      const normalizedToken = sanitizeToken(token);
      const config = {
        method,
        url,
        headers: {
          Authorization: `Bearer ${normalizedToken}`,
        },
        ...options,
      };

      const response = await apiClient.request(config);
      setActionResponse({
        label,
        status: response.status,
        body: normalizeResponse(response.data),
      });
    } catch (error) {
      const status = error.response?.status;

      setActionError(
        `Request failed${status ? ` (HTTP ${status})` : ''}: ${
          error.response?.data?.message || error.message || 'Unknown error'
        }`
      );
    } finally {
      setActionLoading(false);
    }
  };

  const handleVerifyEnv = () => {
    // NOTE: Backend route is /api/verify-env (not /api/env-verify).
    handleAdminAction('Verify Environment', 'get', '/api/verify-env');
  };

  const handleClearPinecone = () => {
    handleAdminAction('Clear Pinecone Index', 'delete', '/api/pinecone/clear');
  };

  const handleTestSearch = () => {
    const params = testQuery ? { params: { q: testQuery } } : {};
    handleAdminAction('Test Search', 'get', '/api/pinecone/test-search', params);
  };

  return (
    <div className="admin-root">
      <header className="admin-header">
        <h1>Visor AI Admin Dashboard</h1>
        <p className="admin-subtitle">
          Secure tools for ingestion and diagnostics. This UI runs inside the same Render service
          as your AI Agent Hybrid backend.
        </p>
      </header>

      <main className="admin-main">
        {/* Token Section */}
        <section className="admin-card">
          <h2>Admin Token</h2>
          <p className="admin-help">
            Paste the <code>ADMIN_API_KEY</code> configured in Render. It is only kept in memory
            for this tab and never written to localStorage, cookies, or logs.
          </p>
          <input
            type="password"
            className="admin-input"
            placeholder="Bearer token (ADMIN_API_KEY)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
          <p className="admin-warning">
            Do not share this token. Rotate it from Render if you suspect it has been exposed.
          </p>
        </section>

        {/* File Upload Section */}
        <section className="admin-card">
          <h2>File Ingestion</h2>
          <p className="admin-help">
            Upload PDF, JSON, CSV, or TXT files to <code>POST /api/ingest</code>. Files are sent
            one by one with your admin token in the <code>Authorization</code> header.
          </p>
          <div className="admin-upload-row">
            <input
              id="admin-file-input"
              type="file"
              multiple
              accept=".pdf,.csv,.json,.txt"
              onChange={handleFilesChange}
              disabled={uploading}
            />
            <button
              className="admin-button primary"
              onClick={handleUpload}
              disabled={uploading || !files.length}
            >
              {uploading ? 'Uploading…' : `Upload ${files.length || ''} file(s)`}
            </button>
          </div>
          <div className="admin-upload-log">
            <h3>Upload Log</h3>
            {uploadLog.length === 0 ? (
              <p className="admin-log-empty">No uploads yet.</p>
            ) : (
              <ul>
                {uploadLog.map((entry) => (
                  <li
                    key={entry.id}
                    className={
                      entry.type === 'success'
                        ? 'admin-log-entry success'
                        : 'admin-log-entry error'
                    }
                  >
                    {entry.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Admin Actions Section */}
        <section className="admin-card">
          <h2>Diagnostics & Maintenance</h2>
          <div className="admin-actions">
            <button
              className="admin-button"
              onClick={handleVerifyEnv}
              disabled={actionLoading}
            >
              ✅ Verify Environment
            </button>
            <button
              className="admin-button danger"
              onClick={handleClearPinecone}
              disabled={actionLoading}
            >
              🧹 Clear Pinecone Index
            </button>
          </div>

          <div className="admin-test-search">
            <label htmlFor="test-search-input">Test Search Query</label>
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
                <span className="admin-response-status">
                  HTTP {actionResponse.status}
                </span>
              </div>
              <pre className="admin-response-body">{actionResponse.body}</pre>
            </div>
          )}
        </section>
      </main>

      <footer className="admin-footer">
        <p>
          Served from <code>/admin</code> by the existing Express server. Build via Vite into
          <code> server/public/admin</code>.
        </p>
      </footer>
    </div>
  );
}

export default AdminDashboard;

