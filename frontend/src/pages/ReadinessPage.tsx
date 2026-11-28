import { PlacementRadarPanel } from '../features/readiness/components/PlacementRadarPanel';
import React from 'react';
import { motion } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Code2, Cpu, Layers, Map, TrendingUp, MessageSquare, Target, Flame, ShieldCheck, RefreshCw } from 'lucide-react';
import axiosClient from '../utils/axiosClient';
import { NetworkErrorPanel } from '../components/shared/NetworkErrorPanel';
import { useReadinessData } from '../features/readiness/hooks/useReadinessData';
import { ReadinessHero } from '../features/readiness/components/ReadinessHero';
import { DomainCard } from '../features/readiness/components/DomainCard';
import { useFeatureFlags } from '../features/flags/hooks/useFeatureFlags';
import { INTERVIEW_STUDIO_FLAG, INTERVIEW_STUDIO_PATH } from '../features/interview/interview';

const ReadinessPage: React.FC = () => {
  const { data, loading, error, refetch } = useReadinessData();
  const { isEnabled } = useFeatureFlags();
  const queryClient = useQueryClient();
  const handleRetry = React.useCallback(() => { void refetch(); }, [refetch]);

  const syncAllMutation = useMutation({
    mutationFn: async () => {
      await axiosClient.post('/platforms/sync-all');
      await axiosClient.post('/readiness/dsa/sync');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['readinessData'] });
      void queryClient.invalidateQueries({ queryKey: ['placementRadar'] });
      void queryClient.invalidateQueries({ queryKey: ['dsaIntelligence'] });
    },
  });

  if (loading) {
    return (
      <div className="flex flex-col gap-8 max-w-[1400px] mx-auto w-full pb-16 px-4 animate-pulse">
        <div className="h-32 w-full bg-slate-100 rounded-[20px] border border-slate-200" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-40 bg-slate-100 rounded-[20px] border border-slate-200" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-48 bg-slate-100 rounded-[20px] border border-slate-200" />
          <div className="h-48 bg-slate-100 rounded-[20px] border border-slate-200" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return <NetworkErrorPanel error={error || 'No data available'} onRetry={handleRetry} variant="centered" />;
  }



  // Get first next-best-action per domain for domain cards
  const dsaAction = data.nextBestActions?.find((a: any) => a.category === 'dsa');

  const domainConfigs = [
    {
      id: 'dsa',
      title: 'DSA Intelligence',
      description: 'Algorithmic maturity analysis',
      route: '/readiness/dsa',
      icon: <Code2 size={18} />,
      accentColor: '#8B5CF6',
      gradientFrom: '#F5F3FF',
      gradientTo: '#EDE9FE',
      summary: data.rawMetrics?.dsa
        ? `${data.rawMetrics.dsa.totalSolved ?? data.rawMetrics.dsa.totalSolves ?? 0} problems solved, ${data.rawMetrics.dsa.consistencyScore ?? data.rawMetrics.dsa.solveConsistency ?? 0}% consistency`
        : undefined,
      nextAction: dsaAction?.title,
    },
    {
      id: 'roadmap',
      title: 'Roadmap Intelligence',
      description: 'Adaptive progression engine',
      route: '/readiness/roadmap',
      icon: <Map size={18} />,
      accentColor: '#10B981',
      gradientFrom: '#ECFDF5',
      gradientTo: '#D1FAE5',
      summary: data.adaptiveRoadmap?.length ? `${data.adaptiveRoadmap.length} progression nodes tracked` : undefined,
    },
    {
      id: 'evolution',
      title: 'Evolution Intelligence',
      description: 'Engineering trajectory analysis',
      route: '/readiness/evolution',
      icon: <TrendingUp size={18} />,
      accentColor: '#F59E0B',
      gradientFrom: '#FFFBEB',
      gradientTo: '#FEF3C7',
      summary: data.rawMetrics?.benchmarks?.cohortSegments?.[0] ? `Top ${100 - (data.rawMetrics.benchmarks.cohortSegments[0].percentileRanking || 0)}% in cohort` : undefined,
    },
    {
      id: 'copilot',
      title: 'AI Guidance',
      description: 'Engineering guidance terminal',
      route: '/readiness/copilot',
      icon: <MessageSquare size={18} />,
      accentColor: '#EC4899',
      gradientFrom: '#FDF2F8',
      gradientTo: '#FCE7F3',
      summary: 'Ask why, get evidence-backed answers',
    },
    {
      id: 'evidence',
      title: 'Evidence Ledger',
      description: 'Claims behind your score',
      route: '/readiness/evidence',
      icon: <ShieldCheck size={18} />,
      accentColor: '#0EA5E9',
      gradientFrom: '#F0F9FF',
      gradientTo: '#E0F2FE',
      summary: 'See what is verified, partial or flagged',
    },
    {
      id: 'system-design',
      title: 'System Design Concepts',
      description: 'Beginner to Case Studies architecture',
      route: '/readiness/system-design',
      icon: <Layers size={18} />,
      accentColor: '#4F46E5',
      gradientFrom: '#EEF2FF',
      gradientTo: '#E0E7FF',
      summary: 'Protocols, caching, sharding, queues & 5 real-world blueprints',
    },
    {
      id: 'cs-distributed',
      title: 'CS Concepts',
      description: 'OS, DBMS, Networks + optional Distributed',
      route: '/readiness/cs-distributed',
      icon: <Cpu size={18} />,
      accentColor: '#0F766E',
      gradientFrom: '#F0FDFA',
      gradientTo: '#CCFBF1',
      summary: 'Core fundamentals scored directly + optional Distributed Systems track',
    },
  ];

  return (
    <div className="flex flex-col gap-6 max-w-[1400px] mx-auto w-full pb-16 px-4 md:px-6 overflow-x-hidden">
      {/* ─── PAGE HEADER ─── */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center shrink-0">
            <Target size={18} className="text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-black tracking-tight text-slate-800">Readiness Intelligence</h1>
            <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mt-0.5">Engineering Progression Overview</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => syncAllMutation.mutate()}
            disabled={syncAllMutation.isPending}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw size={15} aria-hidden="true" className={syncAllMutation.isPending ? 'animate-spin' : ''} />
            {syncAllMutation.isPending ? 'Syncing…' : 'Sync Telemetry'}
          </button>
          {isEnabled(INTERVIEW_STUDIO_FLAG) && (
            <Link to={INTERVIEW_STUDIO_PATH}
              className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-white px-4 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-50">
              <MessageSquare size={16} aria-hidden="true" /> Practice an interview
            </Link>
          )}
        </div>
      </motion.div>

      <motion.div
        initial="initial"
        animate="animate"
        variants={{
          initial: { opacity: 0 },
          animate: { opacity: 1, transition: { staggerChildren: 0.08 } },
        }}
        className="flex flex-col gap-8"
      >
        {/* 1. READINESS HERO */}
        <ReadinessHero data={data} />
        <PlacementRadarPanel />

        {/* 2. INTELLIGENCE WORKSPACES */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Flame size={14} className="text-indigo-500" />
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Intelligence Workspaces</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {domainConfigs.map((cfg, i) => (
              <DomainCard
                key={cfg.id}
                {...cfg}
                momentum={data.dynamicState?.momentumTrend}
                confidence={data.dynamicState?.confidence}
                index={i}
              />
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default ReadinessPage;
