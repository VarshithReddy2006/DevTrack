import type { FC } from 'react';
import type { ContestPlatform } from '../contestsUtils';

export type FilterPlatform = 'all' | ContestPlatform;

export interface PlatformFilterPillsProps {
  selected: FilterPlatform;
  onChange: (platform: FilterPlatform) => void;
  counts?: Partial<Record<FilterPlatform, number>>;
  className?: string;
}

export const PLATFORM_CONFIG: Record<
  FilterPlatform,
  { label: string; badgeBg: string; activeClass: string; inactiveClass: string; dotColor: string }
> = {
  all: {
    label: 'All Platforms',
    badgeBg: 'bg-zinc-100 text-zinc-700',
    activeClass: 'border-[#7C5CFF] bg-[#7C5CFF] text-white shadow-sm',
    inactiveClass: 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50',
    dotColor: 'bg-purple-400',
  },
  leetcode: {
    label: 'LeetCode',
    badgeBg: 'bg-amber-100 text-amber-800',
    activeClass: 'border-amber-500 bg-amber-500 text-white shadow-sm',
    inactiveClass: 'border-zinc-200 bg-white text-zinc-600 hover:border-amber-300 hover:bg-amber-50/50',
    dotColor: 'bg-amber-500',
  },
  codeforces: {
    label: 'Codeforces',
    badgeBg: 'bg-blue-100 text-blue-800',
    activeClass: 'border-blue-600 bg-blue-600 text-white shadow-sm',
    inactiveClass: 'border-zinc-200 bg-white text-zinc-600 hover:border-blue-300 hover:bg-blue-50/50',
    dotColor: 'bg-blue-600',
  },
  atcoder: {
    label: 'AtCoder',
    badgeBg: 'bg-rose-100 text-rose-800',
    activeClass: 'border-rose-600 bg-rose-600 text-white shadow-sm',
    inactiveClass: 'border-zinc-200 bg-white text-zinc-600 hover:border-rose-300 hover:bg-rose-50/50',
    dotColor: 'bg-rose-600',
  },
  codechef: {
    label: 'CodeChef',
    badgeBg: 'bg-orange-100 text-orange-800',
    activeClass: 'border-orange-600 bg-orange-600 text-white shadow-sm',
    inactiveClass: 'border-zinc-200 bg-white text-zinc-600 hover:border-orange-300 hover:bg-orange-50/50',
    dotColor: 'bg-orange-600',
  },
};

const PLATFORMS_LIST: FilterPlatform[] = ['all', 'leetcode', 'codeforces', 'atcoder', 'codechef'];

export const PlatformFilterPills: FC<PlatformFilterPillsProps> = ({
  selected,
  onChange,
  counts = {},
  className = '',
}) => {
  return (
    <fieldset
      className={`flex flex-wrap items-center gap-2 ${className}`}
      aria-label="Filter contests by platform"
    >
      <legend className="sr-only">Filter contests by platform</legend>
      {PLATFORMS_LIST.map((platformKey) => {
        const config = PLATFORM_CONFIG[platformKey];
        const isActive = selected === platformKey;
        const count = counts[platformKey];

        return (
          <button
            key={platformKey}
            type="button"
            role="button"
            aria-pressed={isActive}
            aria-label={`${config.label} contests${count !== undefined ? ` (${count})` : ''}`}
            onClick={() => onChange(platformKey)}
            className={[
              'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-all duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C5CFF] focus-visible:ring-offset-2',
              isActive ? config.activeClass : config.inactiveClass,
            ].join(' ')}
          >
            {/* Active or platform dot indicator */}
            <span
              className={`h-2 w-2 rounded-full transition-transform ${
                isActive ? 'bg-white scale-110' : config.dotColor
              }`}
              aria-hidden="true"
            />
            <span>{config.label}</span>

            {/* Contest count pill */}
            {count !== undefined && (
              <span
                className={`ml-1 rounded-full px-1.5 py-0.2 text-[10px] font-bold tabular-nums leading-tight transition-colors ${
                  isActive
                    ? 'bg-white/25 text-white'
                    : 'bg-zinc-100 text-zinc-600'
                }`}
                aria-hidden="true"
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </fieldset>
  );
};
