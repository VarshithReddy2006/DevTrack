import type { ContestPlatform } from './contestsUtils';

const PLATFORMS: { id: ContestPlatform; label: string }[] = [
  { id: 'leetcode', label: 'LeetCode' },
  { id: 'codeforces', label: 'Codeforces' },
  { id: 'atcoder', label: 'AtCoder' },
  { id: 'codechef', label: 'CodeChef' },
];

interface PlatformFilterChipsProps {
  selected: ContestPlatform[];
  onChange: (platforms: ContestPlatform[]) => void;
}

export function PlatformFilterChips({ selected, onChange }: PlatformFilterChipsProps) {
  const toggle = (platform: ContestPlatform) => {
    onChange(
      selected.includes(platform)
        ? selected.filter((item) => item !== platform)
        : [...selected, platform]
    );
  };

  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">Filter contests by platform</legend>
      {PLATFORMS.map(({ id, label }) => {
        const active = selected.includes(id);
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(id)}
            className={[
              'rounded-full border px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C5CFF] focus-visible:ring-offset-2',
              active
                ? 'border-[#7C5CFF] bg-[#7C5CFF]/10 text-[#5B3DF5]'
                : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50',
            ].join(' ')}
          >
            {label}
          </button>
        );
      })}
    </fieldset>
  );
}
