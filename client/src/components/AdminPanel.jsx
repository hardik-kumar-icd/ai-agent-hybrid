import React, { useState } from 'react';
import './AdminPanel.css';

/**
 * AdminPanel Component
 * Allows admins to upload files for AI knowledge ingestion
 */
function AdminPanel({ baseUrl, adminToken }) {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadLog, setUploadLog] = useState([]);
  const [testQuery, setTestQuery] = useState('');
  const [testResponse, setTestResponse] = useState('');
  const [testing, setTesting] = useState(false);

  const apiBaseUrl = baseUrl || 'https://sinkerless-sententially-abrielle.ngrok-free.dev';
  
  // Get token: prop > localStorage (don't prompt on mount, only when needed)
  const [token, setToken] = useState(() => {
    // First check prop
    if (adminToken) return adminToken;
    // Then check localStorage
    const savedToken = localStorage.getItem('visor_admin_token');
    return savedToken || null;
  });

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files);
    setSelectedFiles(files);
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      addLogEntry('error', 'Please select at least one file to upload.');
      return;
    }

    // Check for token, prompt if missing
    let currentToken = token;
    if (!currentToken) {
      const manualToken = prompt('Enter your admin token for file upload:');
      if (!manualToken) {
        addLogEntry('error', 'Admin token is required for file upload.');
        return;
      }
      localStorage.setItem('visor_admin_token', manualToken);
      setToken(manualToken);
      currentToken = manualToken;
    }

    setUploading(true);

    // Upload files one by one
    for (const file of selectedFiles) {
      try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`${apiBaseUrl}/api/ingest`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentToken}`
          },
          body: formData
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Unauthorized: Invalid admin token');
          } else if (response.status === 413) {
            throw new Error('File too large');
          } else if (response.status === 429) {
            throw new Error('Rate limit exceeded. Please wait a moment.');
          } else {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `Upload failed: ${response.status}`);
          }
        }

        const data = await response.json();
        addLogEntry('success', `✓ ${file.name} uploaded successfully${data.sourceName ? ` (${data.sourceName})` : ''}`);
      } catch (error) {
        console.error('Upload error:', error);
        addLogEntry('error', `✗ ${file.name}: ${error.message || 'Upload failed'}`);
      }
    }

    setUploading(false);
    setSelectedFiles([]);
    // Reset file input
    const fileInput = document.getElementById('admin-file-input');
    if (fileInput) {
      fileInput.value = '';
    }
  };

  const handleTestQuery = async () => {
    if (!testQuery.trim()) {
      return;
    }

    setTesting(true);
    setTestResponse('');

    try {
      const response = await fetch(`${apiBaseUrl}/visor-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: testQuery
        })
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const data = await response.json();
      setTestResponse(data.reply || 'No response received.');
    } catch (error) {
      console.error('Test query error:', error);
      setTestResponse(`Error: ${error.message || 'Failed to get response'}`);
    } finally {
      setTesting(false);
    }
  };

  const addLogEntry = (type, message) => {
    const timestamp = new Date().toLocaleTimeString();
    setUploadLog(prev => [...prev, { type, message, timestamp }].slice(-20)); // Keep last 20 entries
  };

  const clearLog = () => {
    setUploadLog([]);
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-content">
        {/* File Upload Section */}
        <div className="admin-section">
          <h3>File Upload</h3>
          <div className="admin-upload-area">
            <input
              id="admin-file-input"
              type="file"
              multiple
              accept=".pdf,.csv,.json,.txt"
              onChange={handleFileChange}
              disabled={uploading}
              className="admin-file-input"
            />
            <div className="admin-file-list">
              {selectedFiles.length > 0 ? (
                <ul>
                  {selectedFiles.map((file, idx) => (
                    <li key={idx}>{file.name} ({(file.size / 1024).toFixed(2)} KB)</li>
                  ))}
                </ul>
              ) : (
                <p className="admin-file-placeholder">No files selected</p>
              )}
            </div>
            <button
              className="admin-upload-button"
              onClick={handleUpload}
              disabled={uploading || selectedFiles.length === 0}
            >
              {uploading ? 'Uploading...' : `Upload ${selectedFiles.length} File(s)`}
            </button>
          </div>
        </div>

        {/* Upload Log Section */}
        <div className="admin-section">
          <div className="admin-log-header">
            <h3>Upload Log</h3>
            {uploadLog.length > 0 && (
              <button className="admin-clear-button" onClick={clearLog}>
                Clear
              </button>
            )}
          </div>
          <div className="admin-log-area">
            {uploadLog.length === 0 ? (
              <p className="admin-log-placeholder">No uploads yet</p>
            ) : (
              <ul className="admin-log-list">
                {uploadLog.map((entry, idx) => (
                  <li key={idx} className={`admin-log-entry admin-log-${entry.type}`}>
                    <span className="admin-log-time">{entry.timestamp}</span>
                    <span className="admin-log-message">{entry.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Test Query Section */}
        <div className="admin-section">
          <h3>Test Query</h3>
          <div className="admin-test-area">
            <textarea
              className="admin-test-input"
              placeholder="Enter a test question to verify knowledge base..."
              value={testQuery}
              onChange={(e) => setTestQuery(e.target.value)}
              disabled={testing}
              rows="3"
            />
            <button
              className="admin-test-button"
              onClick={handleTestQuery}
              disabled={testing || !testQuery.trim()}
            >
              {testing ? 'Testing...' : 'Test Query'}
            </button>
            {testResponse && (
              <div className="admin-test-response">
                <strong>Response:</strong>
                <div dangerouslySetInnerHTML={{ __html: formatMessage(testResponse) }}></div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Format message text - convert markdown bold to HTML
 */
function formatMessage(text) {
  if (!text) return '';
  
  // Escape HTML to prevent XSS
  const escapeHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };
  
  // Escape all HTML first
  let escaped = escapeHtml(text);
  
  // Convert **text** to <strong>text</strong>
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Convert line breaks to <br>
  escaped = escaped.replace(/\n/g, '<br>');
  
  return escaped;
}

export default AdminPanel;
