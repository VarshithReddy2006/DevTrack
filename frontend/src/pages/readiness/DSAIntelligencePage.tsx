import React, { useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle,
  Clock,
  Code2,
  Cpu,
  HelpCircle,
  Layers,
  RefreshCw,
  Target,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { useDSAIntelligence, useSyncDSAIntelligence } from '../../features/readiness/hooks/useDSAIntelligence';
import { EmptyState } from '../../components/shared/EmptyState';
import type {
  TopicDifficultyBreakdown,
  TopicTier,
} from '../../features/readiness/services/dsaIntelligenceService';
import {
  deriveTopicTier,
  estimateProblemsToBridge,
  formatTopicLabel,
  getProblemSearchUrl,
  TOPIC_CATALOG,
} from '../../features/readiness/dsaTopicCatalog';

const DATA_STRUCTURE_KEYS = [
  'arrays',
  'hashing',
  'strings',
  'linkedList',
  'stack',
  'queue',
  'trees',
  'graphs',
  'heaps',
] as const;

const ALGORITHM_KEYS = [
  'dp',
  'greedy',
  'binarySearch',
  'backtracking',
  'recursion',
] as const;

const TIER_BADGE_CLASSES: Record<TopicTier, string> = {
  Mastery: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  Advanced: 'text-sky-700 bg-sky-50 border-sky-200',
  Proficient: 'text-indigo-700 bg-indigo-50 border-indigo-200',
  Novice: 'text-amber-700 bg-amber-50 border-amber-200',
};

function barFillClass(mastery: number): string {
  if (mastery >= 70) return 'bg-emerald-500';
  if (mastery >= 40) return 'bg-indigo-500';
  if (mastery > 0) return 'bg-amber-500';
  return 'bg-slate-300';
}

function badgeTextClass(mastery: number): string {
  if (mastery >= 70) return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (mastery >= 40) return 'text-indigo-700 bg-indigo-50 border-indigo-200';
  if (mastery > 0) return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-slate-500 bg-slate-50 border-slate-200';
}

const UNRATED_TOOLTIP =
  'Problems solved in unrated platforms or contests without standard LeetCode difficulty tags';

const DifficultyChart: React.FC<{ dist: { easy: number; medium: number; hard: number; total: number } }> = ({ dist }) => {
  const isZeroState = dist.total === 0;
  const knownSum = dist.easy + dist.medium + dist.hard;
  const unrated = Math.max(0, dist.total - knownSum);
  const denom = Math.max(1, dist.total, knownSum + unrated);

  const buckets = [
    {
      label: 'Easy',
      value: dist.easy,
      pct: Math.round((dist.easy / denom) * 100),
      barClass: 'bg-emerald-500',
      badgeClass: 'text-emerald-700 bg-emerald-50 border-emerald-200',
      tooltip: 'Solved Easy problems tagged on synced platforms',
    },
    {
      label: 'Medium',
      value: dist.medium,
      pct: Math.round((dist.medium / denom) * 100),
      barClass: 'bg-amber-500',
      badgeClass: 'text-amber-700 bg-amber-50 border-amber-200',
      tooltip: 'Solved Medium problems tagged on synced platforms',
    },
    {
      label: 'Hard',
      value: dist.hard,
      pct: Math.round((dist.hard / denom) * 100),
      barClass: 'bg-rose-500',
      badgeClass: 'text-rose-700 bg-rose-50 border-rose-200',
      tooltip: 'Solved Hard problems tagged on synced platforms',
    },
    {
      label: 'Unrated / Contest',
      value: unrated,
      pct: Math.round((unrated / denom) * 100),
      barClass: 'bg-slate-400',
      badgeClass: 'text-slate-600 bg-slate-100 border-slate-200',
      tooltip: UNRATED_TOOLTIP,
    },
  ];

  return (
    <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-5">
        <div>
          <h2 className="text-base font-bold text-slate-900">Difficulty Distribution</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Breakdown of solved problems across difficulty tiers and unrated contests
          </p>
        </div>
        {!isZeroState && (
          <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
            <span className="text-xs font-medium text-slate-500">Total Analyzed</span>
            <span className="text-sm font-bold text-slate-900 tabular-nums">{dist.total}</span>
          </div>
        )}
      </div>

      {isZeroState ? (
        <div className="flex flex-col items-center justify-center py-8 rounded-xl border border-dashed border-slate-200 bg-slate-50/50">
          <Cpu className="w-8 h-8 text-slate-400 mb-2" />
          <p className="text-sm font-medium text-slate-500">Awaiting initial telemetry...</p>
        </div>
      ) : (
        <>
          <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden flex mb-6">
            {buckets.map((b) => (
              <div
                key={b.label}
                className={`${b.barClass} h-full transition-all duration-500`}
                style={{ width: `${(b.value / denom) * 100}%` }}
                title={`${b.label}: ${b.value} (${b.pct}%) — ${b.tooltip}`}
              />
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {buckets.map((d) => (
              <div
                key={d.label}
                title={d.tooltip}
                className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-4"
              >
                <div className="flex items-baseline justify-between gap-2 mb-2">
                  <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {d.label}
                    {d.label === 'Unrated / Contest' && (
                      <HelpCircle
                        size={12}
                        className="text-slate-400 shrink-0"
                        aria-label={UNRATED_TOOLTIP}
                      />
                    )}
                  </span>
                  <span className="text-2xl font-bold text-slate-900 tabular-nums">{d.value}</span>
                </div>
                <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden mb-2">
                  <div className={`h-full ${d.barClass} rounded-full`} style={{ width: `${d.pct}%` }} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-500">Share of solved</span>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border ${d.badgeClass}`}>
                    {d.pct}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
};

interface CategoryTopicItem {
  topic: string;
  label: string;
  solved: number;
  mastery: number;
  tier: TopicTier;
  difficulty?: TopicDifficultyBreakdown;
  isEstimatedDifficulty?: boolean;
}

const ESTIMATED_DIFFICULTY_TOOLTIP =
  'Estimated from overall platform difficulty distribution';

const CategoryBreakdownCard: React.FC<{
  title: string;
  subtitle: string;
  items: CategoryTopicItem[];
}> = ({ title, subtitle, items }) => {
  const avgMastery = items.length
    ? Math.round(items.reduce((sum, item) => sum + item.mastery, 0) / items.length)
    : 0;
  const totalTaggedSolves = items.reduce((sum, item) => sum + item.solved, 0);

  return (
    <section className="rounded-2xl bg-white border border-slate-200/80 p-6 shadow-xs flex flex-col min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0">
            <Layers size={16} className="text-indigo-600" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900">{title}</h2>
            <p className="text-xs text-slate-500">{subtitle}</p>
          </div>
        </div>
        <span className="text-xs font-semibold text-slate-600 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-md shrink-0 tabular-nums">
          Avg {avgMastery}% · {totalTaggedSolves} tagged
        </span>
      </div>

      <div className="space-y-4">
        {items.map((item) => (
          <div key={item.topic} className="space-y-1.5">
            {/* Line 1: Topic label + Tier badge (left), Mastery % pill (right) */}
            <div className="flex items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium text-slate-800 truncate">{item.label}</span>
                {item.solved > 0 && (
                  <span
                    className={`inline-flex shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${TIER_BADGE_CLASSES[item.tier]}`}
                  >
                    {item.tier}
                  </span>
                )}
              </div>
              <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded border tabular-nums ${badgeTextClass(item.mastery)}`}>
                {item.mastery}%
              </span>
            </div>

            {/* Line 2: Full-width smooth progress bar */}
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${barFillClass(item.mastery)}`}
                style={{ width: `${Math.min(100, Math.max(0, item.mastery))}%` }}
              />
            </div>

            {/* Line 3 (caption): X solved (left) + [ E | M | H ] breakdown (right) */}
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
              <span className="tabular-nums">{item.solved} solved</span>
              {item.difficulty && (
                <span
                  title={item.isEstimatedDifficulty ? ESTIMATED_DIFFICULTY_TOOLTIP : undefined}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200/80 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                  aria-label={`${item.isEstimatedDifficulty ? 'Estimated ' : ''}Easy ${item.difficulty.easy}, Medium ${item.difficulty.medium}, Hard ${item.difficulty.hard}`}
                >
                  {item.isEstimatedDifficulty && (
                    <span className="text-slate-400" aria-hidden="true">~</span>
                  )}
                  <span className="text-slate-400">[</span>
                  <span className="text-emerald-600">E: {item.difficulty.easy}</span>
                  <span className="text-slate-300">|</span>
                  <span className="text-amber-600">M: {item.difficulty.medium}</span>
                  <span className="text-slate-300">|</span>
                  <span className="text-rose-600">H: {item.difficulty.hard}</span>
                  <span className="text-slate-400">]</span>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

const DSAIntelligencePage: React.FC = () => {
  const inRouter = useInRouterContext();
  const [showAllStrong, setShowAllStrong] = useState(false);
  const { data, isLoading, isFetching, isRefetchError, error } = useDSAIntelligence();
  const syncMutation = useSyncDSAIntelligence();
  const isSyncing = isFetching || syncMutation.isPending;
  const hasSyncError = (isRefetchError || syncMutation.isError) && !isSyncing;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 max-w-[1400px] mx-auto w-full pb-28 px-4 pt-6 animate-pulse">
        <div className="h-14 w-72 bg-slate-200 rounded-xl" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-28 bg-white rounded-2xl border border-slate-200" />
          ))}
        </div>
        <div className="h-56 bg-white rounded-2xl border border-slate-200" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-slate-800">
        <EmptyState
          size="lg"
          icon="alert"
          title="Unable to Load DSA Intelligence"
          description={error?.message || 'Could not load algorithmic analysis.'}
          action={
            <button
              type="button"
              onClick={() => syncMutation.mutate()}
              className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 transition-colors"
            >
              Retry Connection
            </button>
          }
        />
      </div>
    );
  }

  const isZeroState =
    data.readinessScore === 0 &&
    data.consistencyScore === 0 &&
    data.difficultyDistribution.total === 0;

  // Merge strongTopics + weakTopics into a single map for categorized rendering
  const topicMap = new Map<
    string,
    { solved: number; mastery: number; tier: TopicTier; difficulty?: TopicDifficultyBreakdown; isEstimatedDifficulty?: boolean }
  >();
  for (const t of [...(data.strongTopics ?? []), ...(data.weakTopics ?? [])]) {
    if (typeof t === 'string') {
      if (!topicMap.has(t)) topicMap.set(t, { solved: 0, mastery: 0, tier: 'Novice' });
    } else {
      topicMap.set(t.topic, {
        solved: t.solved,
        mastery: t.mastery,
        tier: deriveTopicTier(t.mastery, t.tier),
        difficulty: t.difficulty,
        isEstimatedDifficulty: t.isEstimatedDifficulty,
      });
    }
  }

  const buildCategoryItems = (keys: readonly string[]): CategoryTopicItem[] =>
    keys.map((key) => {
      const entry = topicMap.get(key) ?? { solved: 0, mastery: 0, tier: 'Novice' as TopicTier };
      return {
        topic: key,
        label: formatTopicLabel(key),
        solved: entry.solved,
        mastery: entry.mastery,
        tier: entry.tier,
        difficulty: entry.difficulty,
        isEstimatedDifficulty: entry.isEstimatedDifficulty,
      };
    });

  const dataStructureItems = buildCategoryItems(DATA_STRUCTURE_KEYS);
  const algorithmItems = buildCategoryItems(ALGORITHM_KEYS);
  const strongTopics = data.strongTopics ?? [];
  const visibleStrongTopics = showAllStrong ? strongTopics : strongTopics.slice(0, 6);
  const weakTopics = data.weakTopics ?? [];
  const nextTopicSet = new Set(data.nextTopics ?? []);
  const remainingWeakTopics = weakTopics.filter((t) => {
    const key = typeof t === 'string' ? t : t.topic;
    return !nextTopicSet.has(key);
  });

  const statusMeta: Record<string, { label: string; className: string }> = {
    improving: { label: 'Improving Trend', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    declining: { label: 'Declining Trend', className: 'bg-rose-50 text-rose-700 border-rose-200' },
    stable: { label: 'Steady Pace', className: 'bg-slate-100 text-slate-700 border-slate-200' },
  };
  const currentStatus = statusMeta[data.status] ?? statusMeta.stable;

  const kpiCards = [
    {
      label: 'Readiness Core',
      value: data.readinessScore,
      suffix: '%',
      helper: 'Problem volume, difficulty mix & topic depth',
      icon: <Target className="w-4 h-4 text-indigo-600" />,
      iconBg: 'bg-indigo-50 border-indigo-100',
    },
    {
      label: 'Consistency',
      value: data.consistencyScore,
      suffix: '%',
      helper: 'Active streak & recent solve frequency',
      icon: <Zap className="w-4 h-4 text-emerald-600" />,
      iconBg: 'bg-emerald-50 border-emerald-100',
    },
    {
      label: 'Hard Progress',
      value: data.hardProgressScore,
      suffix: '%',
      helper: 'Hard problem share & recent trajectory',
      icon: <TrendingUp className="w-4 h-4 text-rose-600" />,
      iconBg: 'bg-rose-50 border-rose-100',
    },
    {
      label: 'Impact Factor',
      value: data.readinessImpact,
      suffix: 'pts',
      helper: 'Contribution to overall placement score',
      icon: <CheckCircle className="w-4 h-4 text-sky-600" />,
      iconBg: 'bg-sky-50 border-sky-100',
    },
  ];

  const backLink = inRouter ? (
    <Link
      to="/readiness"
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors mb-2"
    >
      <ArrowLeft size={14} />
      Readiness Overview
    </Link>
  ) : (
    <a
      href="/readiness"
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors mb-2"
    >
      <ArrowLeft size={14} />
      Readiness Overview
    </a>
  );

  return (
    <div className="min-h-screen bg-slate-50/40 text-slate-900 pb-28 md:pb-24 overflow-x-hidden">
      <div className="max-w-[1400px] mx-auto w-full px-4 md:px-6 pt-4 flex flex-col gap-6 min-w-0">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            {backLink}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0">
                <Code2 className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900">DSA Intelligence</h1>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-0.5">
                  Algorithmic Readiness & Topic Mastery
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <span className={`inline-flex items-center px-3 py-1.5 rounded-lg border text-xs font-semibold ${currentStatus.className}`}>
              {currentStatus.label}
            </span>
            {!isZeroState && (
              <button
                type="button"
                onClick={() => syncMutation.mutate()}
                disabled={isSyncing}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-xs transition-colors hover:bg-slate-50 disabled:opacity-60"
              >
                <RefreshCw size={15} aria-hidden="true" className={isSyncing ? 'motion-safe:animate-spin' : ''} />
                {isSyncing ? 'Syncing…' : 'Refresh Telemetry'}
              </button>
            )}
          </div>
        </header>

        {/* Empty State Sync Callout */}
        {isZeroState && (
          <div className="rounded-2xl border border-indigo-200 bg-indigo-50/70 p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-start sm:items-center gap-3.5">
              <div className="shrink-0 rounded-xl bg-indigo-100 p-2.5">
                <Cpu className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-900">No DSA practice telemetry synced yet</h2>
                <p className="text-xs text-slate-600 mt-0.5">
                  Connect your LeetCode or Codeforces account in Settings, or sync now to extract solved problems and topic tags.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => syncMutation.mutate()}
              disabled={isSyncing}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-indigo-700 disabled:opacity-70"
            >
              {isSyncing && <RefreshCw size={15} aria-hidden="true" className="motion-safe:animate-spin" />}
              {isSyncing ? 'Syncing…' : 'Sync Data'}
            </button>
          </div>
        )}

        {hasSyncError && (
          <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700">
            Could not refresh DSA data. Showing the last loaded results.
          </p>
        )}

        {/* KPI Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {kpiCards.map((m) => (
            <div
              key={m.label}
              className="rounded-2xl bg-white border border-slate-200 p-5 shadow-xs hover:border-slate-300 transition-colors"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{m.label}</span>
                <div className={`p-2 rounded-lg border ${m.iconBg}`}>{m.icon}</div>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-bold tracking-tight text-slate-900">{m.value}</span>
                <span className="text-sm font-semibold text-slate-500">{m.suffix}</span>
              </div>
              <p className="text-xs text-slate-500 mt-2">{m.helper}</p>
            </div>
          ))}
        </section>

        {/* Difficulty Distribution */}
        <DifficultyChart dist={data.difficultyDistribution} />

        {/* Categorized Data Structures & Algorithms Mastery */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <CategoryBreakdownCard
            title="Data Structures Mastery"
            subtitle="Extracted from solved problem tags across connected platforms"
            items={dataStructureItems}
          />
          <CategoryBreakdownCard
            title="Algorithmic Paradigms"
            subtitle="Core problem-solving patterns weighted by interview benchmarks"
            items={algorithmItems}
          />
        </div>

        {/* Balanced Bottom Workspace: Topic Health Summary (Left) + Actionable Practice Cards (Right) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Strong Topics + Remaining Topics Below 60% */}
          <div className="lg:col-span-5 flex flex-col gap-6 min-w-0">
            <section className="rounded-2xl bg-white border border-slate-200/80 p-6 shadow-xs min-w-0">
              <div className="flex items-center justify-between gap-2 mb-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-100 shrink-0">
                    <CheckCircle size={16} className="text-emerald-600" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-sm font-bold text-slate-900">Strong Topics</h2>
                    <p className="text-xs text-slate-500">Topics with 60%+ difficulty-weighted mastery</p>
                  </div>
                </div>
                {strongTopics.length > 6 && (
                  <button
                    type="button"
                    onClick={() => setShowAllStrong((prev) => !prev)}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 px-2.5 py-1 rounded-lg hover:bg-indigo-50 transition-colors shrink-0 whitespace-nowrap cursor-pointer"
                  >
                    {showAllStrong ? 'Show top 6' : `Show all (${strongTopics.length})`}
                  </button>
                )}
              </div>
              {strongTopics.length > 0 ? (
                <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {visibleStrongTopics.map((t, i) => {
                    const topicKey = typeof t === 'string' ? t : t.topic;
                    const tier = typeof t === 'string' ? 'Novice' : deriveTopicTier(t.mastery, t.tier);
                    return (
                      <div
                        key={topicKey || i}
                        className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-emerald-50/40 border border-emerald-100"
                      >
                        <span className="text-sm font-medium text-slate-800 truncate min-w-0">
                          {formatTopicLabel(topicKey)}
                        </span>
                        {typeof t !== 'string' && (
                          <div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
                            <span className="text-xs font-bold text-emerald-700 tabular-nums">
                              {t.solved} solved ({t.mastery}%)
                            </span>
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${TIER_BADGE_CLASSES[tier]}`}
                            >
                              {tier}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-6 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                  <p className="text-xs text-slate-500 font-medium">Solve more weighted problems to unlock strong domains.</p>
                </div>
              )}
            </section>

            {remainingWeakTopics.length > 0 && (
              <section className="rounded-2xl bg-white border border-slate-200/80 p-6 shadow-xs min-w-0">
                <div className="flex items-center gap-2.5 mb-4">
                  <div className="p-2 rounded-lg bg-amber-50 border border-amber-100 shrink-0">
                    <Target size={16} className="text-amber-600" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-sm font-bold text-slate-900">Additional Gaps Below 60%</h2>
                    <p className="text-xs text-slate-500">Secondary topics outside your top action cards</p>
                  </div>
                </div>
                <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {remainingWeakTopics.map((t, i) => {
                    const topicKey = typeof t === 'string' ? t : t.topic;
                    const tier = typeof t === 'string' ? 'Novice' : deriveTopicTier(t.mastery, t.tier);
                    return (
                      <div
                        key={topicKey || i}
                        className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200/70"
                      >
                        <span className="text-sm font-medium text-slate-800 truncate min-w-0">
                          {formatTopicLabel(topicKey)}
                        </span>
                        {typeof t !== 'string' && (
                          <div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
                            <span className="text-xs font-semibold text-amber-700 tabular-nums">
                              {t.solved} solved ({t.mastery}%)
                            </span>
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${TIER_BADGE_CLASSES[tier]}`}
                            >
                              {tier}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          {/* Right Column: Actionable Next Topic Practice Cards */}
          <section className="lg:col-span-7 rounded-2xl bg-white border border-slate-200/80 p-6 shadow-xs min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-5">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-indigo-50 border border-indigo-100">
                  <Zap size={16} className="text-indigo-600" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-900">Recommended Next Topics</h2>
                  <p className="text-xs text-slate-500">
                    Actionable practice plan prioritized for your target role
                  </p>
                </div>
              </div>
              {data.nextTopics && data.nextTopics.length > 0 && (
                <span className="text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2.5 py-1 rounded-md">
                  {data.nextTopics.length} High-Leverage Targets
                </span>
              )}
            </div>

            {data.nextTopics && data.nextTopics.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {data.nextTopics.map((topic, i) => {
                  const catalog = TOPIC_CATALOG[topic];
                  const topicLabel = formatTopicLabel(topic);
                  const entry = topicMap.get(topic);
                  const currentMastery = entry?.mastery ?? 0;
                  const gapEstimate = estimateProblemsToBridge(topic, currentMastery);
                  const priorityLabel = i === 0 ? 'Top Priority · High Impact' : catalog?.priorityBadge ?? 'High Impact';
                  const curated = catalog?.curatedProblem;
                  const problemText = curated
                    ? `${curated.title} (${curated.difficulty})`
                    : `${topicLabel} Practice Set`;
                  const problemUrl = getProblemSearchUrl(topic);
                  const focusMission = `Master ${topicLabel}`;
                  const focusPath = `/focus?mission=${encodeURIComponent(focusMission)}&duration=25&mode=dsa`;

                  return (
                    <article
                      key={topic}
                      className="rounded-xl border border-indigo-100 bg-gradient-to-br from-indigo-50/40 via-white to-slate-50/60 p-4 flex flex-col justify-between gap-3.5 hover:border-indigo-200 transition-colors"
                    >
                      <div className="space-y-2.5 min-w-0">
                        <div className="flex flex-col gap-2 min-w-0">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs font-bold shrink-0">
                              {i + 1}
                            </span>
                            <h3 className="text-sm font-bold text-slate-900 leading-snug break-words">{topicLabel}</h3>
                          </div>
                          <span className="inline-flex w-fit text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700">
                            {priorityLabel}
                          </span>
                        </div>

                        <div className="rounded-lg bg-white/90 border border-slate-200/80 px-3 py-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                            Recommended Problem
                          </p>
                          <p className="text-xs font-semibold text-slate-800 mt-0.5">{problemText}</p>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                          <span className="whitespace-nowrap">
                            Mastery: <strong className="text-slate-700 tabular-nums">{currentMastery}%</strong>
                          </span>
                          <span className="font-medium text-amber-700 whitespace-nowrap">{gapEstimate}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <a
                          href={problemUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex flex-1 min-w-[130px] items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors"
                        >
                          Solve Problem
                          <ArrowUpRight size={13} aria-hidden="true" />
                        </a>
                        {inRouter ? (
                          <Link
                            to={focusPath}
                            className="inline-flex flex-1 min-w-[155px] items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                          >
                            <Clock size={13} aria-hidden="true" className="text-indigo-600" />
                            Start 25m Focus Block
                          </Link>
                        ) : (
                          <a
                            href={focusPath}
                            className="inline-flex flex-1 min-w-[155px] items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                          >
                            <Clock size={13} aria-hidden="true" className="text-indigo-600" />
                            Start 25m Focus Block
                          </a>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="py-10 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                <p className="text-xs text-slate-500 font-medium">No pending topic recommendations — you are on track!</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default DSAIntelligencePage;
