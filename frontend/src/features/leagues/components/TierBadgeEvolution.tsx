import { motion } from 'framer-motion';
import { ArrowRight, Shield } from 'lucide-react';
import { bouncy, prefersReducedMotion } from '../../../design-system/motion';
import { divisionLabel } from '../leagueUtils';
import type { LeagueDivision } from '../types';

const TIER_COLORS: Record<LeagueDivision, { from: string; to: string }> = {
  bronze: { from: '#D97745', to: '#9A4A22' },
  silver: { from: '#CBD5E1', to: '#64748B' },
  gold: { from: '#FBBF24', to: '#D97706' },
  platinum: { from: '#67E8F9', to: '#0E7490' },
  diamond: { from: '#93C5FD', to: '#4F46E5' },
  master: { from: '#C084FC', to: '#7E22CE' },
  grandmaster: { from: '#FB7185', to: '#BE123C' },
};

const CONFETTI_COLORS = ['#F59E0B', '#FBBF24', '#34D399', '#60A5FA', '#F472B6', '#FFFFFF'];

function TierBadge({ division, size }: { division: LeagueDivision; size: 'sm' | 'lg' }) {
  const { from, to } = TIER_COLORS[division];
  const box = size === 'lg' ? 'h-24 w-24 rounded-3xl' : 'h-14 w-14 rounded-2xl';
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        data-testid={`tier-badge-${division}`}
        className={`relative flex items-center justify-center shadow-lg ${box}`}
        style={{ background: `linear-gradient(135deg, ${from}, ${to})`, boxShadow: size === 'lg' ? `0 16px 48px ${from}66` : undefined }}
      >
        <div className="absolute inset-0 rounded-[inherit] bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.45),transparent_55%)]" />
        <Shield className="relative text-white" size={size === 'lg' ? 44 : 26} aria-hidden="true" />
      </div>
      <span className={size === 'lg' ? 'text-sm font-bold text-zinc-900' : 'text-xs font-semibold text-zinc-500'}>{divisionLabel(division)}</span>
    </div>
  );
}

function ConfettiBurst({ count }: { count: number }) {
  return (
    <div aria-hidden="true" data-testid="promotion-confetti" className="pointer-events-none absolute inset-0 overflow-visible">
      {Array.from({ length: count }, (_, index) => {
        // Deterministic spread keeps renders stable while still looking scattered.
        const angle = (index / count) * Math.PI * 2;
        const distance = 70 + (index % 4) * 22;
        const size = 5 + (index % 3) * 2;
        return (
          <motion.span
            key={index}
            className="absolute left-1/2 top-1/2 block"
            style={{
              width: index % 3 === 2 ? size * 2 : size,
              height: index % 3 === 2 ? 3 : size,
              backgroundColor: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
              borderRadius: index % 3 === 0 ? '50%' : 2,
            }}
            initial={{ x: 0, y: 0, opacity: 1, scale: 0, rotate: 0 }}
            animate={{
              x: Math.cos(angle) * distance,
              y: Math.sin(angle) * distance + 40,
              opacity: [1, 1, 0],
              scale: [0, 1.2, 0.6],
              rotate: (index % 2 === 0 ? 1 : -1) * (180 + index * 20),
            }}
            transition={{ duration: 1.6, ease: 'easeOut', delay: 0.45 + (index % 5) * 0.04 }}
          />
        );
      })}
    </div>
  );
}

interface TierBadgeEvolutionProps {
  from: LeagueDivision;
  to: LeagueDivision;
}

/** Old tier badge giving way to the new one, with a confetti burst unless reduced motion is on. */
export function TierBadgeEvolution({ from, to }: TierBadgeEvolutionProps) {
  return (
    <div role="img" aria-label={`Tier badge changes from ${divisionLabel(from)} to ${divisionLabel(to)}`} className="flex items-center justify-center gap-5">
      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 1, scale: 1 }}
        animate={prefersReducedMotion ? undefined : { opacity: 0.55, scale: 0.9 }}
        transition={{ delay: 0.2, duration: 0.3 }}
      >
        <TierBadge division={from} size="sm" />
      </motion.div>
      <ArrowRight className="text-zinc-400" size={22} aria-hidden="true" />
      <div className="relative">
        {!prefersReducedMotion && <ConfettiBurst count={22} />}
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.4, rotate: -12 }}
          animate={prefersReducedMotion ? undefined : { opacity: 1, scale: 1, rotate: 0 }}
          transition={{ ...bouncy, delay: 0.35 }}
        >
          <TierBadge division={to} size="lg" />
        </motion.div>
      </div>
    </div>
  );
}
