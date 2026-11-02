// ============================================================================
// PlatformStatsCard.tsx — Advanced Analytics Matrix
// ============================================================================

import React from 'react';
import { motion } from 'framer-motion';
import type { LeetCodeStats, CodeforcesStats, CodeChefStats, GithubStats, PlatformState } from '../../types/profile.types';

import leetcodeLogo from '@/assets/logos/LeetCode.png';
import codeforcesLogo from '@/assets/logos/Codeforces.png';
import codechefLogo from '@/assets/logos/CodeChef.png';

// ---------------------------------------------------------------------------
// Helper: Codeforces Rank Colors (Premium Palette)
// ---------------------------------------------------------------------------
function cfRankColor(rank?: string): string {
  const r = (rank ?? '').toLowerCase();
  if (r.includes('legendary') || r.includes('tourist')) return '#ef4444';
  if (r.includes('grandmaster')) return '#f87171';
  if (r.includes('master')) return '#fb923c';
  if (r.includes('expert')) return '#6366f1';
  if (r.includes('specialist')) return '#2dd4bf';
  if (r.includes('pupil')) return '#4ade80';
  return '#94a3b8';
}

// ---------------------------------------------------------------------------
// Component: Difficulty Track
// ---------------------------------------------------------------------------
const DifficultyTrack: React.FC<{ label: string; solved: number; total: number; color: string }> = ({ label, solved, total, color }) => {
  const pct = total > 0 ? Math.min((solved / total) * 100, 100) : 0;
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-[9px] font-black uppercase text-slate-400 tracking-wider">{label}</span>
        <span className="text-[10px] font-bold text-slate-600">{solved} / {total}</span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1, ease: "easeOut" }}
        />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Component: LeetCode Card
// ---------------------------------------------------------------------------
export const LeetCodeStatsCard: React.FC<{ state: PlatformState<LeetCodeStats>; username: string }> = React.memo(({ state, username }) => {
  if (!state.data && !state.loading) return null;

  return (
    <div className="platform-stats-card" style={{ '--accent': '#f59e0b' } as React.CSSProperties}>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-50 flex items-center justify-center p-1.5">
            <img src={leetcodeLogo} alt="LeetCode" className="w-full h-full object-contain" />
          </div>
          <div>
            <div className="text-xs font-black text-slate-900 tracking-tight">LeetCode</div>
            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">@{username}</div>
          </div>
        </div>
        {state.data && <div className="platform-stats-card__rating-badge">{Math.round(state.data.contestRating)}</div>}
      </div>

      <div className="flex-1 space-y-5">
        <div className="grid grid-cols-2 gap-2">
          <div className="platform-stat-item">
            <div className="platform-stat-item__label">Solved</div>
            <div className="platform-stat-item__value">{state.data?.solvedProblem ?? '—'}</div>
          </div>
          <div className="platform-stat-item">
            <div className="platform-stat-item__label">Top %</div>
            <div className="platform-stat-item__value">{state.data?.contestTopPercentage?.toFixed(1) ?? '—'}%</div>
          </div>
        </div>

        <div className="p-3.5 rounded-2xl bg-slate-50/50 border border-slate-100">
          <DifficultyTrack label="Easy" solved={state.data?.easySolved || 0} total={state.data?.totalEasy || 0} color="#10b981" />
          <DifficultyTrack label="Medium" solved={state.data?.mediumSolved || 0} total={state.data?.totalMedium || 0} color="#f59e0b" />
          <DifficultyTrack label="Hard" solved={state.data?.hardSolved || 0} total={state.data?.totalHard || 0} color="#ef4444" />
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Component: Codeforces Card
// ---------------------------------------------------------------------------
export const CodeforcesStatsCard: React.FC<{ state: PlatformState<CodeforcesStats>; username: string }> = React.memo(({ state, username }) => {
  if (!state.data && !state.loading) return null;
  const color = state.data ? cfRankColor(state.data.rank) : '#94a3b8';

  return (
    <div className="platform-stats-card" style={{ '--accent': color } as React.CSSProperties}>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center p-1.5">
            <img src={codeforcesLogo} alt="Codeforces" className="w-full h-full object-contain" />
          </div>
          <div>
            <div className="text-xs font-black text-slate-900 tracking-tight">Codeforces</div>
            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">@{username}</div>
          </div>
        </div>
        {state.data && <div className="platform-stats-card__rating-badge" style={{ color }}>{state.data.rating}</div>}
      </div>

      <div className="flex-1 space-y-5">
        <div className="grid grid-cols-2 gap-2">
          <div className="platform-stat-item">
            <div className="platform-stat-item__label">Solved</div>
            <div className="platform-stat-item__value">{state.data?.totalSolved ?? '—'}</div>
          </div>
          <div className="platform-stat-item">
            <div className="platform-stat-item__label">Contests</div>
            <div className="platform-stat-item__value">{state.data?.totalContests ?? '—'}</div>
          </div>
        </div>

        <div className="p-3.5 rounded-2xl bg-slate-50/50 border border-slate-100 h-full">
          <div className="flex justify-between items-center mb-4">
            <span className="text-[9px] font-black uppercase text-slate-400">Current Standing</span>
            <span className="text-[10px] font-black uppercase" style={{ color }}>{state.data?.rank || 'Unrated'}</span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[8px] font-bold text-slate-400 uppercase mb-1">Max Rating</div>
              <div className="text-xs font-black text-slate-700">{state.data?.maxRating ?? '—'}</div>
            </div>
            <div>
              <div className="text-[8px] font-bold text-slate-400 uppercase mb-1">Contribution</div>
              <div className="text-xs font-black text-emerald-500">{state.data?.contribution ?? '0'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Component: CodeChef Card
// ---------------------------------------------------------------------------
export const CodeChefStatsCard: React.FC<{ state: PlatformState<CodeChefStats>; username: string }> = React.memo(({ state, username }) => {
  if (!state.data && !state.loading) return null;

  return (
    <div className="platform-stats-card" style={{ '--accent': '#8B4513' } as React.CSSProperties}>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-orange-50 flex items-center justify-center p-1.5">
            <img src={codechefLogo} alt="CodeChef" className="w-full h-full object-contain" />
          </div>
          <div>
            <div className="text-xs font-black text-slate-900 tracking-tight">CodeChef</div>
            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">@{username}</div>
          </div>
        </div>
        {state.data && <div className="platform-stats-card__rating-badge">{state.data.stars}</div>}
      </div>

      <div className="flex-1 space-y-5">
        <div className="grid grid-cols-2 gap-2">
          <div className="platform-stat-item">
            <div className="platform-stat-item__label">Rating</div>
            <div className="platform-stat-item__value">{state.data?.currentRating ?? '—'}</div>
          </div>
          <div className="platform-stat-item">
            <div className="platform-stat-item__label">Solved</div>
            <div className="platform-stat-item__value">{state.data?.totalProblemsSolved ?? '—'}</div>
          </div>
        </div>

        <div className="p-3.5 rounded-2xl bg-slate-50/50 border border-slate-100">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[8px] font-bold text-slate-400 uppercase mb-1">Global Rank</div>
              <div className="text-xs font-black text-slate-700">#{state.data?.globalRank?.toLocaleString() ?? '—'}</div>
            </div>
            <div>
              <div className="text-[8px] font-bold text-slate-400 uppercase mb-1">Highest</div>
              <div className="text-xs font-black text-slate-700">{state.data?.highestRating ?? '—'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Component: GitHub Card (Matches Premium CP Style)
// ---------------------------------------------------------------------------
export const GithubStatsCard: React.FC<{ state: PlatformState<GithubStats>; username: string }> = React.memo(({ state, username }) => {
  if (!state.data && !state.loading) return null;

  return (
    <div className="platform-stats-card" style={{ '--accent': '#0f172a' } as React.CSSProperties}>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-slate-900 flex items-center justify-center p-1.5">
            <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.041-1.416-4.041-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
          </div>
          <div>
            <div className="text-xs font-black text-slate-900 tracking-tight">GitHub</div>
            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">@{username}</div>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-5">
        <div className="grid grid-cols-2 gap-2">
          <div className="platform-stat-item">
            <div className="platform-stat-item__label">Repos</div>
            <div className="platform-stat-item__value">{state.data?.publicRepos ?? '—'}</div>
          </div>
          <div className="platform-stat-item">
            <div className="platform-stat-item__label">Stars</div>
            <div className="platform-stat-item__value">{state.data?.totalStars ?? '—'}</div>
          </div>
        </div>

        <div className="p-3.5 rounded-2xl bg-slate-50/50 border border-slate-100">
          <div className="text-[8px] font-black uppercase text-slate-400 mb-2.5">Core Tech Stack</div>
          <div className="flex flex-wrap gap-1.5">
            {state.data?.topLanguages?.slice(0, 3).map(lang => (
              <span key={lang} className="px-2 py-0.5 bg-white border border-slate-200 rounded-md text-[9px] font-bold text-slate-600 shadow-sm">
                {lang}
              </span>
            ))}
          </div>
          <div className="mt-3.5 pt-3.5 border-t border-slate-100 flex justify-between items-center">
            <span className="text-[8px] font-bold text-slate-400 uppercase">Operational Since</span>
            <span className="text-[10px] font-black text-slate-700">{state.data?.createdAt ? new Date(state.data.createdAt).getFullYear() : '—'}</span>
          </div>
        </div>
      </div>
    </div>
  );
});

LeetCodeStatsCard.displayName = 'LeetCodeStatsCard';
CodeforcesStatsCard.displayName = 'CodeforcesStatsCard';
CodeChefStatsCard.displayName = 'CodeChefStatsCard';
GithubStatsCard.displayName = 'GithubStatsCard';
