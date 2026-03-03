import React from 'react';
import ReactDOM from 'react-dom/client';
import AdminDashboard from './AdminDashboard';
import './AdminDashboard.css';

const rootElement = document.getElementById('root');

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <AdminDashboard />
    </React.StrictMode>
  );
} else {
  // Fallback in case the root element is missing
  // This should never happen if index.html is intact.
  // We intentionally avoid throwing here to prevent a blank page.
  console.error('[AdminDashboard] Root element #root not found');
}

