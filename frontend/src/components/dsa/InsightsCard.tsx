import React from 'react';
import { PlatformLogo } from './PlatformLogo';
import { Icon } from '../shared/Icon';
import type { DsaDifficultyCounts, Platform, Submission, Topic } from '../../types/dsa';

export type InsightsCardProps = {
  title: string;
  submissions: Submission[];
  topics: Topic[];
  solvedByDifficulty?: DsaDifficultyCounts;
  className?: string;
};

const platformLabel: Record<Platform, string> = {
  leetcode: 'LeetCode',
  codeforces: 'Codeforces',
  codechef: 'CodeChef',
  github: 'GitHub',
};

const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const parseSubmissionDate = (value: string) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const InsightsCard: React.FC<InsightsCardProps> = React.memo(
  ({ title, submissions, topics, solvedByDifficulty, className }) => {
    const total = submissions.length;
    const accepted = submissions.filter((s) => s.status === 'accepted').length;
    const acceptanceRate = total > 0 ? Math.round((accepted / total) * 100) : 0;

    const platformCounts = submissions.reduce<Record<Platform, number>>(
      (acc, s) => {
        acc[s.platform] = (acc[s.platform] ?? 0) + 1;
        return acc;
      },
      { leetcode: 0, codeforces: 0, codechef: 0, github: 0 }
    );

    const mostActivePlatform = (Object.keys(platformCounts) as Platform[]).reduce((best, p) =>
      platformCounts[p] > platformCounts[best] ? p : best
      , 'leetcode');

    const topTopic = topics.reduce<Topic | null>((best, t) => {
      if (!best) return t;
      return t.progress > best.progress ? t : best;
    }, null);

    const weakestTopic = topics.reduce<Topic | null>((best, t) => {
      if (!best) return t;
      return t.progress < best.progress ? t : best;
    }, null);

    const insights = React.useMemo(() => {
      const parsed = submissions
        .map((s) => ({ ...s, parsedDate: parseSubmissionDate(s.date) }))
        .filter((s): s is Submission & { parsedDate: Date } => Boolean(s.parsedDate));

      const weekend = parsed.filter((s) => {
        const day = s.parsedDate.getDay();
        return day === 0 || day === 6;
      }).length;
      const weekday = parsed.length - weekend;

      const recent = parsed
        .slice()
        .sort((a, b) => b.parsedDate.getTime() - a.parsedDate.getTime())
        .slice(0, 6);

      const recentWrongByTopic = recent.reduce<Record<string, number>>((acc, s) => {
        if (s.status === 'wrong') acc[s.topic] = (acc[s.topic] ?? 0) + 1;
        return acc;
      }, {});

      const recentWorstTopic = Object.keys(recentWrongByTopic).sort((a, b) => (recentWrongByTopic[b] ?? 0) - (recentWrongByTopic[a] ?? 0))[0] ?? null;

      const weekendBias = weekend > weekday ? 'Solve volume peaks on weekends.' : 'Consistent weekday focus detected.';
      const accuracyHint = recentWorstTopic ? `${recentWorstTopic} accuracy is dipping.` : 'Submission accuracy is stable.';
      const rec = weakestTopic ? `Target ${weakestTopic.name} for mastery ROI.` : 'Push boundaries on hard problems.';

      return [weekendBias, accuracyHint, rec];
    }, [submissions, weakestTopic]);

    const trendData = React.useMemo(() => {
      const today = new Date();
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - (6 - i));
        return d;
      });

      const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });

      const parsed = submissions
        .map((s) => parseSubmissionDate(s.date))
        .filter((d): d is Date => Boolean(d));

      return days.map((day) => {
        const count = parsed.filter((d) => isSameDay(d, day)).length;
        return { day: fmt.format(day), count };
      });
    }, [submissions]);

    const max = Math.max(1, ...trendData.map((d) => d.count));
    const weeklyGoal = 18;
    const weeklyDone = trendData.reduce((a, b) => a + b.count, 0);

    const difficultySegments = solvedByDifficulty ? [
      { label: 'Easy', count: solvedByDifficulty.easy, color: '#10B981' },
      { label: 'Medium', count: solvedByDifficulty.medium, color: '#F59E0B' },
      { label: 'Hard', count: solvedByDifficulty.hard, color: '#F43F5E' },
      { label: 'Unknown', count: solvedByDifficulty.unknown, color: '#64748B' },
    ] : [];
    const solvedTotal = difficultySegments.reduce((sum, item) => sum + item.count, 0);

    return (
      <section
        className={[
          'bg-white/80 backdrop-blur-3xl rounded-[32px] border border-dt-primary/10 shadow-[0_8px_40px_rgba(124,92,252,0.06)] overflow-hidden transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] hover:shadow-[0_16px_60px_rgba(124,92,252,0.12)] group/insights relative p-8 lg:p-10',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,92,252,0.03),transparent_50%)] pointer-events-none" />

        {/* Intelligence Mesh Glow - Smaller */}
        <div className="absolute -top-16 -right-16 w-64 h-64 bg-dt-primary/10 rounded-full blur-[60px] pointer-events-none group-hover/insights:scale-[1.5] transition-transform duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] opacity-60" />

        <div className="relative z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-dt-primary shadow-[0_0_8px_rgba(124,92,252,0.8)] animate-pulse" />
              <p className="text-[10px] font-black text-dt-primary uppercase tracking-[0.2em]">Neural Synthesis Engine</p>
            </div>
            <h3 className="text-2xl font-black tracking-tighter text-dt-text">{title}</h3>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-dt-primary/10 border border-dt-primary/20 text-dt-primary text-[10px] font-black uppercase tracking-widest group-hover/insights:border-dt-primary/40 transition-colors shadow-inner w-fit">
            <div className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-dt-primary opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-dt-primary"></span>
            </div>
            Live AI Processing
          </div>
        </div>

        {/* Intelligence Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10 relative z-10">
          <div className="bg-white/60 backdrop-blur-md p-5 rounded-[20px] border border-dt-primary/10 group-hover/insights:border-dt-primary/20 transition-colors shadow-sm hover:shadow-[0_8px_30px_rgba(124,92,252,0.06)] hover:-translate-y-0.5 duration-300 relative overflow-hidden">
             <div className="absolute top-0 right-0 w-16 h-16 bg-dt-primary/5 rounded-full blur-[20px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-dt-textSecondary/60 mb-2">Acceptance</p>
            <p className="text-3xl font-black tracking-tighter text-dt-text leading-none">{acceptanceRate}%</p>
          </div>
          <div className="bg-white/60 backdrop-blur-md p-5 rounded-[20px] border border-dt-primary/10 group-hover/insights:border-dt-primary/20 transition-colors shadow-sm hover:shadow-[0_8px_30px_rgba(124,92,252,0.06)] hover:-translate-y-0.5 duration-300 relative overflow-hidden">
             <div className="absolute top-0 right-0 w-16 h-16 bg-dt-primary/5 rounded-full blur-[20px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-dt-textSecondary/60 mb-2">Active Hub</p>
            <div className="flex items-center gap-2 mt-1">
              <PlatformLogo platform={mostActivePlatform} iconSize={18} />
              <p className="text-xl font-black tracking-tighter text-dt-text truncate leading-none">{platformLabel[mostActivePlatform]}</p>
            </div>
          </div>
          <div className="bg-white/60 backdrop-blur-md p-5 rounded-[20px] border border-dt-primary/10 group-hover/insights:border-dt-primary/20 transition-colors shadow-sm hover:shadow-[0_8px_30px_rgba(124,92,252,0.06)] hover:-translate-y-0.5 duration-300 relative overflow-hidden">
             <div className="absolute top-0 right-0 w-16 h-16 bg-dt-primary/5 rounded-full blur-[20px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-dt-textSecondary/60 mb-2">Prime Vector</p>
            <p className="text-xl font-black tracking-tighter text-dt-text truncate leading-none mt-1">{topTopic?.name ?? '—'}</p>
          </div>
        </div>

        <div className="relative z-10 flex flex-col xl:flex-row gap-10">
          {/* Visual Analytics */}
          <div className="flex-1 flex flex-col gap-9">
            <div>
              <div className="flex items-center justify-between mb-5">
                <p className="text-[10px] font-black text-dt-textSecondary/50 uppercase tracking-widest">Velocity Pipeline</p>
                <div className="px-2 py-0.5 rounded-md bg-dt-primary/5 border border-dt-primary/10">
                  <span className="text-[9px] font-black text-dt-primary">{weeklyDone}/{weeklyGoal} Weekly</span>
                </div>
              </div>
              <div className="flex items-end gap-1.5 h-16">
                {trendData.map((d, i) => {
                  const h = Math.round((d.count / max) * 64);
                  const isToday = i === trendData.length - 1;
                  return (
                    <div key={d.day} className="flex-1 flex flex-col items-center gap-2 group/bar">
                      <div
                        className={['w-full max-w-[28px] rounded-t-lg rounded-b-[3px] transition-all duration-700 cubic-bezier(0.22, 1, 0.36, 1)', isToday ? 'bg-dt-primary shadow-[0_0_15px_rgba(124,92,252,0.4)] scale-x-110' : 'bg-dt-textDisabled/20 group-hover/bar:bg-dt-primary/40 group-hover/bar:scale-y-105'].join(' ')}
                        style={{ height: `${Math.max(4, h)}px` }}
                      />
                      <span className={['text-[9px] font-black uppercase tracking-tighter', isToday ? 'text-dt-primary' : 'text-dt-textMuted opacity-40'].join(' ')}>{d.day}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {solvedByDifficulty && (
              <div className="flex flex-col gap-4">
                <p className="text-[10px] font-black text-dt-textSecondary/50 uppercase tracking-widest">Solved by difficulty</p>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-dt-bg/40 flex shadow-inner" aria-hidden="true">
                  {difficultySegments.map(({ label, count, color }) => (
                    <div key={label} style={{ width: `${solvedTotal ? count / solvedTotal * 100 : 0}%`, background: color }} />
                  ))}
                </div>
                <ul className="grid grid-cols-2 gap-3 text-[10px] font-black uppercase tracking-widest">
                  {difficultySegments.map(({ label, count, color }) => (
                    <li key={label} className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
                      {label} {count}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* AI Synthesis */}
          <div className="flex-1 flex flex-col gap-5 relative z-10">
            <div className="flex-1 bg-white/60 backdrop-blur-3xl rounded-[24px] p-6 border border-dt-primary/15 shadow-inner relative group/ai overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-dt-primary/10 rounded-full blur-[30px] -translate-y-1/2 translate-x-1/2 pointer-events-none group-hover/ai:scale-150 transition-transform duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]" />
              <div className="absolute top-0 left-0 w-1.5 h-full bg-dt-primary/30 rounded-full" />
              <ul className="space-y-6">
                {insights.map((text, i) => (
                  <li key={`ins-${i}`} className="flex items-start gap-4 group/item">
                    <div className="mt-1.5 w-2 h-2 rounded-full bg-dt-primary shrink-0 shadow-[0_0_10px_rgba(124,92,252,0.8)] group-hover/item:scale-[1.5] transition-transform duration-300" />
                    <span className="text-[15px] font-black text-dt-text leading-snug tracking-tight opacity-90 group-hover/item:opacity-100 transition-opacity">{text}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-[24px] bg-dt-primary/10 p-6 border border-dt-primary/20 flex items-start gap-5 hover:bg-dt-primary/15 transition-all duration-500 group/rec relative overflow-hidden">
              <div className="absolute -top-4 -right-4 w-20 h-20 bg-dt-primary/20 rounded-full blur-[20px] pointer-events-none group-hover/rec:scale-[2] transition-transform duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]" />
              <div className="w-12 h-12 rounded-[16px] bg-white border border-dt-primary/20 flex items-center justify-center shrink-0 shadow-sm group-hover/rec:scale-110 group-hover/rec:shadow-[0_8px_30px_rgba(124,92,252,0.2)] transition-all duration-500 relative z-10">
                <Icon name="bolt" size={20} className="text-dt-primary" />
              </div>
              <div className="relative z-10">
                <p className="text-[10px] font-black text-dt-primary uppercase tracking-[0.2em] mb-1.5">Intelligence ROI Focus</p>
                <p className="text-[16px] font-black text-dt-text leading-tight tracking-tight">
                  {weakestTopic ? `Review ${weakestTopic.name} patterns.` : 'Push boundaries on hard problems.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }
);

InsightsCard.displayName = 'InsightsCard';
