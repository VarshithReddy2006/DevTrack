import React from 'react';
import { motion } from 'framer-motion';
import { Code2, Map, TrendingUp, MessageSquare, Target, Flame, ShieldCheck } from 'lucide-react';
import { NetworkErrorPanel } from '../components/shared/NetworkErrorPanel';
import { useReadinessData } from '../features/readiness/hooks/useReadinessData';
import { ReadinessHero } from '../features/readiness/components/ReadinessHero';
import { DomainCard } from '../features/readiness/components/DomainCard';
import { ActiveBlockersPanel } from '../features/readiness/components/ActiveBlockersPanel';
import { NextBestActionsPanel } from '../features/readiness/components/NextBestActionsPanel';
import { EvolutionPreviewPanel } from '../features/readiness/components/EvolutionPreviewPanel';
import { TrustConfidenceLayer } from '../features/readiness/components/TrustConfidenceLayer';

const ReadinessPage: React.FC = () => {
  const { data, loading, error, refetch } = useReadinessData();
  const handleRetry = React.useCallback(() => { void refetch(); }, [refetch]);

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



  // Extract active blockers from roadmap
  const activeBlockers = (data.adaptiveRoadmap || [])
    .filter((n: any) => n.isPrioritizedBlocker)
    .map((n: any) => ({
      id: n.id,
      label: n.label || n.id,
      reason: 'Limiting progression velocity',
    }));

  // Add weak areas as blockers
  const weakAreaBlockers = (data.dynamicState?.roleAlignment?.weakAreas || []).map((area: string, i: number) => ({
    id: `weak_${i}`,
    label: area,
    reason: `Reducing ${data.dynamicState?.roleAlignment?.role || 'role'} alignment`,
  }));
  const allBlockers = [...activeBlockers, ...weakAreaBlockers].slice(0, 5);

  // Build evolution milestones from intelligence feed achievements
  const milestones = (data.intelligenceFeed || [])
    .filter((f: any) => f.type === 'achievement' || f.type === 'insight')
    .slice(0, 4)
    .map((f: any) => ({
      id: f.id,
      label: f.message,
      type: f.type === 'achievement' ? 'achievement' : 'progress',
      timestamp: f.timestamp,
    }));

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
      summary: data.rawMetrics?.dsa ? `${data.rawMetrics.dsa.totalSolved || 0} problems solved, ${data.rawMetrics.dsa.consistencyScore || 0}% consistency` : undefined,
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
  ];

  return (
    <div className="flex flex-col gap-8 max-w-[1400px] mx-auto w-full pb-16 px-4 md:px-0">
      {/* ─── PAGE HEADER ─── */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex items-center justify-between"
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

        {/* 2. CORE INTELLIGENCE DOMAINS */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Flame size={14} className="text-indigo-500" />
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Intelligence Workspaces</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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

        {/* 3 & 4. BLOCKERS + ACTIONS + EVOLUTION */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: Blockers + Actions */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            <ActiveBlockersPanel blockers={allBlockers} />
            <NextBestActionsPanel data={data} />
          </div>

          {/* Right Column: Evolution + Trust */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            <EvolutionPreviewPanel milestones={milestones} />
            <TrustConfidenceLayer
              confidence={data.dynamicState?.confidence || 0}
              isDegraded={data.rawMetrics?.dsa?.isDegraded || false}
              providerCount={Object.values(data.rawMetrics || {}).filter(Boolean).length}
              verificationCoverage={Math.min(
                Math.round(
                  ((data.rawMetrics?.dsa ? 25 : 0) +
                    (data.rawMetrics?.projects ? 25 : 0) +
                    (data.rawMetrics?.skills ? 25 : 0) +
                    (data.rawMetrics?.benchmarks ? 25 : 0))
                ),
                100
              )}
            />
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default ReadinessPage;
