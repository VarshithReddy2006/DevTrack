import { useEffect, useRef, useState } from 'react';

/** Wait this long after the last change before saving, so dragging sends one update. */
export const SLIDER_COMMIT_DELAY_MS = 500;

interface FlagSliderProps {
  value: number;
  label: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

/** Rollout percentage slider (0–100) that saves once the admin stops moving it. */
export function FlagSlider({ value, label, disabled = false, onCommit }: FlagSliderProps) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  // Follow the server value unless a change is still waiting to be saved.
  useEffect(() => {
    if (timer.current === null) setDraft(value);
  }, [value]);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const change = (next: number) => {
    setDraft(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (next !== value) commitRef.current(next);
    }, SLIDER_COMMIT_DELAY_MS);
  };

  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={draft}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={`${draft}% of users`}
        onChange={(event) => change(Number(event.target.value))}
        className="flex-1 accent-emerald-500 disabled:opacity-50"
      />
      <span className="w-12 text-right font-mono text-xs font-bold text-emerald-400 tabular-nums">{draft}%</span>
    </div>
  );
}
