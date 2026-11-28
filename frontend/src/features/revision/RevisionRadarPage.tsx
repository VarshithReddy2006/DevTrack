import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PageShell } from '../../components/layout/PageShell';
import { queryKeys } from '../../lib/queryClient';
import { useStreakData } from '../../hooks/useDashboardQueries';
import { MAX_DUE_CARDS } from '../../services/revisionService';
import { RetentionHeatmap } from './components/RetentionHeatmap';
import { RevisionReviewDeck } from './components/RevisionReviewDeck';
import { TopicFilterChips } from './components/TopicFilterChips';
import { useDueCardSummary, useRevisionAnalytics } from './hooks/useRevisionRadar';
import { cardMatchesTopic, countOverdue, topicLabel } from './topics';

function StatCard({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="dt-card p-4">
      <p className="text-xs uppercase tracking-wide text-dt-textSecondary">{label}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="text-2xl font-bold text-dt-text">{value}</p>
        {children}
      </div>
    </div>
  );
}

export default function RevisionRadarPage() {
  const queryClient = useQueryClient();
  const analytics = useRevisionAnalytics();
  const due = useDueCardSummary();
  const streak = useStreakData();
  const [topic, setTopic] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const backLink = <Link to="/readiness/dsa" className="dt-btn dt-btn-secondary dt-btn-sm">Back to DSA Intelligence</Link>;
  const data = analytics.data;
  const dueCards = due.data ?? [];
  const overdue = countOverdue(dueCards);
  // Due cards are returned oldest first, so a full batch of overdue cards may hide more.
  const overdueLabel = overdue === MAX_DUE_CARDS ? `${MAX_DUE_CARDS}+` : String(overdue);
  const dueForTopic = topic ? dueCards.filter((card) => cardMatchesTopic(card, topic)).length : dueCards.length;
  // A full summary batch may not include every due card for the selected topic.
  const summaryTruncated = dueCards.length >= MAX_DUE_CARDS;
  const nothingDue = due.isSuccess && dueForTopic === 0 && !summaryTruncated;
  const canStart = due.isSuccess && !nothingDue;

  const endReview = () => {
    setReviewing(false);
    void queryClient.invalidateQueries({ queryKey: queryKeys.revision.all });
  };

  if (analytics.isPending) {
    return (
      <PageShell title="Revision Radar" subtitle="Recall, rate, repeat." status="loading" error={null} actions={backLink}>
        <div role="status" className="dt-card p-8 text-dt-textSecondary">Loading revision radar…</div>
      </PageShell>
    );
  }

  if (analytics.isError || !data) {
    return (
      <PageShell
        title="Revision Radar"
        subtitle="Recall, rate, repeat."
        status="error"
        error={(analytics.error as { message?: string } | null)?.message || 'Could not load revision analytics.'}
        onRetry={() => void analytics.refetch()}
        actions={backLink}
      >
        {null}
      </PageShell>
    );
  }

  if (data.totalCards === 0) {
    return (
      <PageShell title="Revision Radar" subtitle="Recall, rate, repeat." status="success" error={null} actions={backLink}>
        <div className="dt-card p-10 text-center" role="status">
          <h2 className="text-xl font-bold text-dt-text">No revision cards yet</h2>
          <p className="mt-2 text-sm text-dt-textSecondary">Solve problems on your connected platforms to populate your revision deck.</p>
          <Link to="/readiness/dsa" className="dt-btn dt-btn-primary dt-btn-sm mt-5">Go to DSA Intelligence</Link>
        </div>
      </PageShell>
    );
  }

  const streakValue = streak.data ? `${streak.data.currentStreak} day${streak.data.currentStreak === 1 ? '' : 's'}` : '—';

  return (
    <PageShell title="Revision Radar" subtitle="Recall, rate, repeat." status="success" error={null} actions={backLink}>
      <section className="grid gap-3 sm:grid-cols-3" aria-label="Revision overview">
        <StatCard label="Cards due today" value={String(data.cardsDueToday)}>
          {overdue > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">{overdueLabel} overdue</span>}
        </StatCard>
        <StatCard label="Memory strength" value={`${Math.round(data.retentionPercentage)}%`} />
        <StatCard label="Streak" value={streakValue} />
      </section>

      <section className="space-y-3" aria-label="Review controls">
        <TopicFilterChips topics={data.patterns.map((entry) => entry.pattern)} selected={topic} onSelect={setTopic} />
        <div className="flex flex-wrap items-center gap-3">
          {reviewing ? (
            <button type="button" onClick={endReview} className="dt-btn dt-btn-secondary dt-btn-md">End review</button>
          ) : (
            <button type="button" onClick={() => setReviewing(true)} disabled={!canStart} className="dt-btn dt-btn-primary dt-btn-md disabled:opacity-50">
              {topic ? `Start ${topicLabel(topic)} review` : 'Start Daily Review'}
            </button>
          )}
          {!reviewing && nothingDue && (
            <p className="text-sm text-dt-textSecondary">{topic ? `No ${topicLabel(topic)} cards are due right now.` : 'No cards are due right now.'}</p>
          )}
          {!reviewing && due.isError && <p role="alert" className="text-sm text-red-600">Could not check due cards. <button type="button" onClick={() => void due.refetch()} className="underline">Try again</button></p>}
        </div>
      </section>

      {reviewing && <RevisionReviewDeck topic={topic} />}

      <RetentionHeatmap patterns={data.patterns} selected={topic} onSelect={setTopic} />
    </PageShell>
  );
}
