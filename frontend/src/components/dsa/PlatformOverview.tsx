import React, { useEffect, useMemo } from 'react';
import type { Platform, PlatformOverviewItem } from '../../types/dsa';
import { PlatformLogo } from './PlatformLogo';
import { motion, animate, useMotionValue, useTransform } from 'framer-motion';

export type PlatformOverviewProps = {
  title: string;
  items: PlatformOverviewItem[];
  className?: string;
};

const label: Record<Platform, string> = {
  leetcode: 'LeetCode',
  codeforces: 'Codeforces',
  codechef: 'CodeChef',
  github: 'GitHub',
};

const PLATFORM_THEMES: Record<Platform, { glow: string; border: string; accent: string; gradient: string; shimmer: string; shadow: string }> = {
  leetcode: {
    glow: 'bg-orange-500/10',
    border: 'group-hover/item:border-orange-500/40',
    accent: 'text-orange-500',
    gradient: 'from-orange-500/5 to-orange-600/10',
    shimmer: 'via-orange-500/5',
    shadow: 'shadow-orange-500/10',
  },
  codeforces: {
    glow: 'bg-blue-500/10',
    border: 'group-hover/item:border-blue-500/40',
    accent: 'text-blue-500',
    gradient: 'from-blue-500/5 to-blue-600/10',
    shimmer: 'via-blue-500/5',
    shadow: 'shadow-blue-500/10',
  },
  codechef: {
    glow: 'bg-green-500/15',
    border: 'group-hover/item:border-green-500/50',
    accent: 'text-green-600',
    gradient: 'from-green-500/5 to-green-600/15',
    shimmer: 'via-green-500/10',
    shadow: 'shadow-green-500/15',
  },
  github: {
    glow: 'bg-emerald-500/10',
    border: 'group-hover/item:border-emerald-500/40',
    accent: 'text-emerald-500',
    gradient: 'from-emerald-500/5 to-emerald-600/10',
    shimmer: 'via-emerald-500/5',
    shadow: 'shadow-emerald-500/10',
  },
};

const AnimatedNumber: React.FC<{ value: number }> = ({ value }) => {
  const count = useMotionValue(0);
  const rounded = useTransform(count, (latest) => Math.floor(latest));

  useEffect(() => {
    const controls = animate(count, value, {
      duration: 1.5,
      ease: [0.16, 1, 0.3, 1],
    });
    return controls.stop;
  }, [value, count]);

  return <motion.span>{rounded}</motion.span>;
};

export const PlatformOverview: React.FC<PlatformOverviewProps> = React.memo(({ title, items, className }) => {

  // Sort platforms by solved count in increasing order
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => (a.totalSolved ?? 0) - (b.totalSolved ?? 0));
  }, [items]);

  return (
    <section
      className={[
        'bg-white/80 backdrop-blur-3xl rounded-[40px] border border-dt-primary/10 shadow-[0_8px_40px_rgba(124,92,252,0.06)] overflow-hidden transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] hover:shadow-[0_24px_80px_rgba(124,92,252,0.12)] group/ecosystem relative p-10 lg:p-12',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* SaaS Premium Infrastructure - Background Grid */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: `radial-gradient(circle at 1px 1px, #7C5CFC 1px, transparent 0)`, backgroundSize: '40px 40px' }} />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,92,252,0.04),transparent_50%)] pointer-events-none" />

      {/* Dynamic Network Atmosphere */}
      <div className="absolute top-0 left-0 w-[600px] h-[600px] bg-dt-primary/5 rounded-full blur-[100px] -translate-x-1/4 -translate-y-1/4 pointer-events-none opacity-40 group-hover/ecosystem:scale-[1.3] transition-transform duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)]" />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 mb-12 relative z-10">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-2 h-2 rounded-full bg-dt-primary shadow-[0_0_12px_rgba(124,92,252,0.8)] animate-pulse" />
            <span className="text-[11px] font-black text-dt-primary uppercase tracking-[0.3em]">Platform Intelligence Network</span>
          </div>
          <h3 className="text-3xl font-black tracking-tight text-dt-text leading-none">{title}</h3>
        </div>

        <div className="flex items-center gap-6 px-6 py-3 rounded-2xl bg-white/40 border border-dt-primary/5 backdrop-blur-md shadow-sm">
          <div className="flex flex-col items-center">
            <span className="text-[9px] font-black text-dt-textSecondary/40 uppercase tracking-widest mb-1">Platforms shown</span>
            <span className="text-[14px] font-black text-dt-text tracking-tighter">{items.length}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 relative z-10">
        {sortedItems.map((item, index) => {
          const theme = PLATFORM_THEMES[item.platform];
          return (
            <motion.div
              layout
              key={item.platform}
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ 
                layout: { duration: 0.8, ease: [0.16, 1, 0.3, 1] },
                opacity: { duration: 0.5, delay: index * 0.1 },
                scale: { duration: 0.5, delay: index * 0.1 }
              }}
              className={`group/item flex flex-col p-7 rounded-[32px] bg-white/60 backdrop-blur-xl border border-dt-primary/10 hover:bg-white/95 ${theme.border} hover:shadow-[0_20px_50px_rgba(0,0,0,0.08)] ${theme.shadow} hover:-translate-y-2 transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] relative overflow-hidden`}
            >
              <div className={`absolute inset-0 bg-gradient-to-br ${theme.gradient} opacity-0 group-hover/item:opacity-100 transition-opacity duration-700`} />
              <div className={`absolute inset-0 bg-gradient-to-r from-transparent ${theme.shimmer} to-transparent -translate-x-full group-hover/item:animate-[shimmer_2s_infinite]`} />

              {/* Platform Logo + Meta */}
              <div className="flex items-center justify-between mb-8 relative z-10">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 bg-white border border-dt-primary/10 rounded-[20px] flex items-center justify-center shrink-0 shadow-sm group-hover/item:shadow-lg group-hover/item:scale-110 group-hover/item:border-dt-primary/30 transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]">
                    <PlatformLogo platform={item.platform} iconSize={28} />
                  </div>
                  <div>
                    <h4 className="text-[17px] font-black text-dt-text tracking-tight group-hover/item:text-dt-primary transition-colors">{label[item.platform]}</h4>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="text-[9px] font-black text-dt-textSecondary/50 uppercase tracking-widest">Platform stats</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Core Analytics */}
              <div className="flex flex-col gap-1 mb-8 relative z-10">
                <div className="flex items-baseline gap-2">
                  <span className={`text-5xl font-black tracking-tighter text-dt-text group-hover/item:${theme.accent} transition-colors duration-500`}>
                    <AnimatedNumber value={item.totalSolved ?? 0} />
                  </span>
                  <span className="text-[12px] font-black text-dt-textSecondary/40 uppercase tracking-widest mb-1">Solved</span>
                </div>
                {item.rating != null && <span className="text-[10px] font-black text-dt-textSecondary/50 uppercase tracking-widest">Rating: {item.rating}</span>}
              </div>

              {/* Ecosystem Footer */}
              <div className="mt-auto pt-6 border-t border-dt-primary/10 flex items-center justify-between relative z-10">
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] font-black text-dt-textSecondary/40 uppercase tracking-[0.2em]">Platform</span>
                  <span className="text-[13px] font-black text-dt-text tracking-tighter">{label[item.platform]}</span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-[9px] font-black text-dt-textSecondary/40 uppercase tracking-[0.2em]">Global Rank</span>
                  <span className="text-[13px] font-black text-dt-text tracking-tighter">{item.rank ? `#${item.rank}` : 'Unavailable'}</span>
                </div>
              </div>

              {/* Dynamic Reflection Glow */}
              <div className={`absolute -bottom-8 -right-8 w-32 h-32 ${theme.glow} rounded-full blur-[40px] opacity-0 group-hover/item:opacity-100 transition-opacity duration-700 pointer-events-none`} />
            </motion.div>
          );
        })}
      </div>
    </section>
  );
});

PlatformOverview.displayName = 'PlatformOverview';
