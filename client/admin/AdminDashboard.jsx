import React, { useCallback, useEffect, useState } from 'react';
import { useAdminApi } from './hooks/useAdminApi';
import Sidebar from './components/Sidebar';
import OverviewSection from './components/OverviewSection';
import ConversationsSection from './components/ConversationsSection';
import FeedbackSection from './components/FeedbackSection';
import LearnedQaSection from './components/LearnedQaSection';
import KnowledgeBaseSection from './components/KnowledgeBaseSection';
import DiagnosticsSection from './components/DiagnosticsSection';

/**
 * AdminDashboard
 *
 * Drop 5 (minimal) refactor: sidebar nav + sectioned content area.
 *
 * Sections:
 *   - Overview      : summary counts
 *   - Conversations : browse + drill-down (NEW)
 *   - Feedback      : browse + tag analysis (NEW)
 *   - Knowledge Base: file ingestion + Pinecone clear (preserved)
 *   - Diagnostics   : env verify + test search (preserved)
 *
 * Token is held in this top-level state and threaded through useAdminApi to
 * every section. Never persisted to localStorage/cookies/anywhere.
 */
export default function AdminDashboard() {
  const [token, setToken] = useState('');
  const [activeSection, setActiveSection] = useState('overview');

  const { api, get, request, hasToken, normalizedToken } = useAdminApi(token);

  // Shared overview stats so the sidebar can show the thumbs-down badge
  // without each section refetching independently.
  const [overviewStats, setOverviewStats] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(false);

  const refreshOverview = useCallback(async () => {
    if (!hasToken) {
      setOverviewStats(null);
      return;
    }
    setOverviewLoading(true);
    const result = await get('/api/admin/overview');
    setOverviewLoading(false);
    if (result.ok) setOverviewStats(result.data.stats);
  }, [get, hasToken]);

  // Auto-load when token is first set
  useEffect(() => {
    if (hasToken && !overviewStats && !overviewLoading) {
      refreshOverview();
    }
  }, [hasToken, overviewStats, overviewLoading, refreshOverview]);

  return (
    <div className="admin-app">
      <Sidebar
        activeSection={activeSection}
        onSectionChange={setActiveSection}
        token={token}
        onTokenChange={setToken}
        overviewStats={overviewStats}
      />

      <main className="admin-main-content">
        {activeSection === 'overview' && (
          <OverviewSection
            get={get}
            hasToken={hasToken}
            stats={overviewStats}
            refreshStats={refreshOverview}
          />
        )}
        {activeSection === 'conversations' && (
          <ConversationsSection get={get} hasToken={hasToken} />
        )}
        {activeSection === 'feedback' && (
          <FeedbackSection get={get} hasToken={hasToken} />
        )}
        {activeSection === 'learned' && (
          <LearnedQaSection get={get} request={request} hasToken={hasToken} />
        )}
        {activeSection === 'knowledge' && (
          <KnowledgeBaseSection
            api={api}
            hasToken={hasToken}
            normalizedToken={normalizedToken}
          />
        )}
        {activeSection === 'diagnostics' && (
          <DiagnosticsSection request={request} hasToken={hasToken} />
        )}
      </main>
    </div>
  );
}
