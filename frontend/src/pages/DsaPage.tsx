import { PageShell } from '../components/layout/PageShell';
import { useDsaData } from '../hooks/useDsaData';
import React from 'react';
import { SkeletonHeatmap } from '../components/skeletons/SkeletonHeatmap';
import { DsaHero } from '../components/dsa/DsaHero';
import { SubmissionsTable } from '../components/dsa/SubmissionsTable';
import { TopicProgress } from '../components/dsa/TopicProgress';
import { PlatformOverview } from '../components/dsa/PlatformOverview';
import { ContestList } from '../components/dsa/ContestList';
import { InsightsCard } from '../components/dsa/InsightsCard';
import { Icon } from '../components/shared/Icon';
import { NetworkErrorPanel } from '../components/shared/NetworkErrorPanel';

const HeatmapCard = React.lazy(() =>
  import('../components/dsa/HeatmapCard').then((m) => ({ default: m.HeatmapCard }))
);
import type { DsaData } from '../types/dsa';
import { motion, useScroll, useTransform } from 'framer-motion';

// ---------------------------------------------------------------------------
// Sync status helpers
// ---------------------------------------------------------------------------

function formatTimeAgo(isoString: string | null): string {
  if (!isoString) return 'Never synced';
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 60_000) return 'Just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function SyncStatusBar({ isSyncing, lastSyncCompletedAt, lastSyncStatus, isDataStale }: {
  isSyncing: boolean;
  lastSyncCompletedAt: string | null;
  lastSyncStatus: string | null;
  isDataStale: boolean;
}) {
  let message: string;
  let iconName: string;
  let colorClass: string;

  if (isSyncing) {
    message = 'Syncing latest submissions…';
    iconName = 'refresh';
    colorClass = 'text-dt-primary';
  } else if (lastSyncStatus === 'failed') {
    message = 'Sync failed — retrying automatically';
    iconName = 'exclamation-circle';
    colorClass = 'text-red-500';
  } else if (isDataStale) {
    message = 'Data may be outdated';
    iconName = 'clock';
    colorClass = 'text-amber-500';
  } else if (lastSyncCompletedAt) {
    message = `Last synced ${formatTimeAgo(lastSyncCompletedAt)}`;
    iconName = 'check-circle';
    colorClass = 'text-emerald-500';
  } else {
    message = 'Waiting for first sync';
    iconName = 'clock';
    colorClass = 'text-gray-400';
  }

  return (
    <div
      className={`flex items-center gap-1.5 text-[10px] font-bold tracking-widest uppercase transition-opacity duration-300 ${colorClass}`}
      aria-live="polite"
      aria-label={message}
    >
      {isSyncing ? (
        <span className="animate-spin">
          <Icon name={iconName} size={12} className={colorClass} />
        </span>
      ) : (
        <Icon name={iconName} size={12} className={colorClass} />
      )}
      <span>{message}</span>
    </div>
  );
}

const DsaPage: React.FC = () => {
  const { data, loading, error, refetch, isSyncing, isDataStale, schedulerStatus } = useDsaData();
  const [mounted, setMounted] = React.useState(false);
  const { scrollYProgress } = useScroll();

  // Scroll-linked background transformations
  const orb1Y = useTransform(scrollYProgress, [0, 1], [0, -150]);
  const orb2Y = useTransform(scrollYProgress, [0, 1], [0, 150]);
  const orb3Y = useTransform(scrollYProgress, [0, 1], [0, -80]);

  // No mock fallback — show empty defaults when backend returns no data
  const emptyData: DsaData = { stats: [], heatmap: [], submissions: [], contests: [], topics: [], platformOverview: [] };
  const safeData: DsaData = data ?? emptyData;

  // Calendar-year heatmap — data comes pre-aligned from backend (Jan 1 – Dec 31)
  const heatmapCells = React.useMemo(() => safeData.heatmap ?? [], [safeData.heatmap]);

  const handleRetry = React.useCallback(() => { void refetch(); }, [refetch]);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (loading) {
    return (
      <div className="dt-fade-in">
      <div className="dt-fade-in">
        <div className="dt-card dt-card-pad-md dt-skeleton min-h-[120px]" />
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={`stat-skel-${i}`} className="dt-card dt-card-pad-sm dt-skeleton h-[80px]" />
          ))}
        </div>
      </div>
      </div>
    );
  }

  if (error && !data) {
    return <NetworkErrorPanel error={error} onRetry={handleRetry} />;
  }

  return (
    <div className={['transition-all duration-700 cubic-bezier(0.22, 1, 0.36, 1)', mounted ? 'opacity-100' : 'opacity-0'].join(' ')}>
      <PageShell
        title="DSA Tracker"
        subtitle={(
          <SyncStatusBar
            isSyncing={isSyncing}
            lastSyncCompletedAt={schedulerStatus?.lastSyncCompletedAt ?? null}
            lastSyncStatus={schedulerStatus?.lastSyncStatus ?? null}
            isDataStale={isDataStale}
          />
        )}
        status="success"
        error={null}
        actions={(
          <button
            type="button"
            className="dt-btn dt-btn-primary dt-btn-md px-6 shadow-dt-floating"
          >
            <Icon name="plus" size={14} className="text-white" />
            Log Packet
          </button>
        )}
      >
        <div className="mx-auto w-full max-w-[1200px] flex flex-col gap-6 pb-16 relative">

          {/* Elite Atmospheric System - Tighter & More Focused */}
          <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
            <motion.div style={{ y: orb1Y }} className="absolute top-[8%] left-[5%] w-[600px] h-[600px] bg-dt-primary/3 rounded-full blur-[100px] opacity-50" />
            <motion.div style={{ y: orb2Y }} className="absolute top-[50%] right-[0%] w-[400px] h-[500px] bg-dt-secondary/2 rounded-full blur-[80px] opacity-40" />
            <motion.div style={{ y: orb3Y }} className="absolute bottom-[20%] left-[10%] w-[500px] h-[400px] bg-indigo-500/2 rounded-full blur-[90px] opacity-20" />
          </div>

          <div className="relative z-10 flex flex-col gap-6">
            {/* Command Surface: Hero + Heatmap - Compressed */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col gap-4"
            >
              <DsaHero heatmap={heatmapCells} stats={safeData.stats} />
              <React.Suspense fallback={<SkeletonHeatmap />}>
                <HeatmapCard title="Velocity Matrix" cells={heatmapCells} />
              </React.Suspense>
            </motion.div>

            {/* Core Operation Layer - Tighter Grid */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.8, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start"
            >
              <div className="lg:col-span-7 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-dt-primary/5 flex items-center justify-center text-dt-primary border border-dt-primary/10">
                     <Icon name="bolt" size={16} />
                  </div>
                  <div>
                    <h2 className="text-dashboard-title text-[15px] uppercase">Recent Telemetry</h2>
                    <p className="text-label text-[9px] !text-dt-textSecondary/50 mt-0.5">Live submission stream</p>
                  </div>
                </div>
                <SubmissionsTable title="Recent Submissions" submissions={safeData.submissions} />
              </div>

              <div className="lg:col-span-5 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-dt-secondary/5 flex items-center justify-center text-dt-secondary border border-dt-secondary/10">
                     <Icon name="trophy" size={16} />
                  </div>
                  <div>
                    <h2 className="text-dashboard-title text-[15px] uppercase">Competition Matrix</h2>
                    <p className="text-label text-[9px] !text-dt-textSecondary/50 mt-0.5">Performance packets</p>
                  </div>
                </div>
                <ContestList title="Contests" contests={safeData.contests} />
              </div>
            </motion.div>

            {/* Neural Analytics Layer - Tighter */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.8, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start"
            >
              <div className="lg:col-span-5 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/5 flex items-center justify-center text-emerald-600 border border-emerald-500/10">
                     <Icon name="chart-bar" size={16} />
                  </div>
                  <div>
                    <h2 className="text-dashboard-title text-[15px] uppercase">Algorithm Intelligence Matrix</h2>
                    <p className="text-label text-[9px] !text-dt-textSecondary/50 mt-0.5">Algorithmic vectors</p>
                  </div>
                </div>
                <TopicProgress title="Mastery Progress" topics={safeData.topics} />
              </div>

              <div className="lg:col-span-7 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-dt-primary/5 flex items-center justify-center text-dt-primary border border-dt-primary/10">
                     <Icon name="cpu-chip" size={16} />
                  </div>
                  <div>
                    <h2 className="text-dashboard-title text-[15px] uppercase">AI Engineering Brain</h2>
                    <p className="text-label text-[9px] !text-dt-textSecondary/50 mt-0.5">Live neural analysis</p>
                  </div>
                </div>
                <InsightsCard title="Growth Insights" submissions={safeData.submissions} topics={safeData.topics} solvedByDifficulty={safeData.solvedByDifficulty} />
              </div>
            </motion.div>

            {/* Infrastructure Layer - Compressed */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.8, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col gap-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-dt-text/5 flex items-center justify-center text-dt-text border border-dt-text/10">
                   <Icon name="globe-alt" size={16} />
                </div>
                <div>
                  <h2 className="text-dashboard-title text-[15px] uppercase">Platform Intelligence Network</h2>
                  <p className="text-label text-[9px] !text-dt-textSecondary/50 mt-0.5">Ecosystem contribution density</p>
                </div>
              </div>
              <PlatformOverview title="Ecosystem Metrics" items={safeData.platformOverview} />
            </motion.div>
          </div>
        </div>
      </PageShell>
    </div>
  );
};

export default DsaPage;
