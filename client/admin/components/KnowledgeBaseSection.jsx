import React, { useState } from 'react';

/**
 * KnowledgeBaseSection — file ingestion (PDF/JSON/CSV/TXT) + Pinecone clear.
 * Extracted from the original AdminDashboard.jsx with identical behavior.
 */
export default function KnowledgeBaseSection({ api, hasToken, normalizedToken }) {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadLog, setUploadLog] = useState([]);
  const [clearLoading, setClearLoading] = useState(false);
  const [clearResult, setClearResult] = useState(null);
  const [clearError, setClearError] = useState('');

  const appendUploadLog = (entry) => {
    setUploadLog((prev) =>
      [...prev, { ...entry, id: Date.now() + Math.random() }].slice(-50)
    );
  };

  const handleFilesChange = (event) => {
    setFiles(Array.from(event.target.files || []));
  };

  const handleUpload = async () => {
    if (!hasToken) {
      appendUploadLog({ type: 'error', message: 'Admin token required.' });
      return;
    }
    if (!files.length) {
      appendUploadLog({ type: 'error', message: 'Please select at least one file.' });
      return;
    }

    setUploading(true);
    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await api.post('/api/ingest', formData, {
          headers: { Authorization: `Bearer ${normalizedToken}` },
        });
        appendUploadLog({
          type: 'success',
          message: `✓ ${file.name} uploaded (${Math.round(file.size / 1024)} KB)${
            response.data?.sourceName ? ` → ${response.data.sourceName}` : ''
          }`,
        });
      } catch (error) {
        const status = error.response?.status;
        const text =
          error.response?.data?.message || error.message || 'Upload failed';
        appendUploadLog({
          type: 'error',
          message: `✗ ${file.name} (${status || 'ERR'}): ${text}`,
        });
      }
    }
    setUploading(false);
  };

  const handleClearPinecone = async () => {
    if (!hasToken) {
      setClearError('Admin token required.');
      return;
    }
    if (!window.confirm('Clear the entire Pinecone index? This deletes ALL vectors and cannot be undone.')) {
      return;
    }

    setClearLoading(true);
    setClearError('');
    setClearResult(null);
    try {
      const response = await api.delete('/api/pinecone/clear', {
        headers: { Authorization: `Bearer ${normalizedToken}` },
      });
      setClearResult({ status: response.status, data: response.data });
    } catch (error) {
      const status = error.response?.status;
      setClearError(
        `Clear failed${status ? ` (HTTP ${status})` : ''}: ${
          error.response?.data?.message || error.message || 'Unknown error'
        }`
      );
    } finally {
      setClearLoading(false);
    }
  };

  return (
    <div className="admin-section">
      <h2 className="admin-section-title">Knowledge Base</h2>
      <p className="admin-section-subtitle">
        Upload files to the Pinecone knowledge base, or wipe the index entirely.
      </p>

      <div className="admin-card">
        <h3>File Ingestion</h3>
        <p className="admin-help">
          Upload PDF, JSON, CSV, or TXT files to <code>POST /api/ingest</code>.
          Files are sent one at a time with the admin token.
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
          <h4>Upload Log</h4>
          {uploadLog.length === 0 ? (
            <p className="admin-log-empty">No uploads yet.</p>
          ) : (
            <ul>
              {uploadLog.map((entry) => (
                <li
                  key={entry.id}
                  className={`admin-log-entry ${entry.type === 'success' ? 'success' : 'error'}`}
                >
                  {entry.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="admin-card">
        <h3>Danger Zone</h3>
        <p className="admin-help">
          Clear the entire Pinecone vector index. This is irreversible. Use only
          when you need to re-ingest the knowledge base from scratch.
        </p>
        <button
          className="admin-button danger"
          onClick={handleClearPinecone}
          disabled={clearLoading}
        >
          {clearLoading ? 'Clearing…' : '🧹 Clear Pinecone Index'}
        </button>
        {clearError && <p className="admin-error">{clearError}</p>}
        {clearResult && (
          <div className="admin-response">
            <div className="admin-response-header">
              <span className="admin-response-label">Clear Pinecone</span>
              <span className="admin-response-status">HTTP {clearResult.status}</span>
            </div>
            <pre className="admin-response-body">
              {JSON.stringify(clearResult.data, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
