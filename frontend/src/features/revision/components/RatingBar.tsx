import { useEffect } from 'react';
import type { ReviewRating } from '../../../services/revisionService';

interface RatingBarProps {
  onRate: (rating: ReviewRating) => void;
  disabled?: boolean;
}

const ratings: { rating: ReviewRating; key: string; label: string; detail: string; style: string }[] = [
  { rating: 'failed', key: '1', label: 'Failed', detail: 'Reset to 1 day', style: 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100' },
  { rating: 'hard', key: '2', label: 'Hard', detail: 'Needs reinforcement', style: 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100' },
  { rating: 'easy', key: '3', label: 'Easy', detail: 'Mastered', style: 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100' },
];

export function RatingBar({ onRate, disabled = false }: RatingBarProps) {
  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      const selected = ratings.find((item) => item.key === event.key);
      if (selected) onRate(selected.rating);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [disabled, onRate]);

  return (
    <div className="grid gap-3 sm:grid-cols-3" aria-label="Rate this review">
      {ratings.map(({ rating, key, label, detail, style }) => (
        <button
          key={rating}
          type="button"
          disabled={disabled}
          onClick={() => onRate(rating)}
          className={`rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dt-primary disabled:cursor-wait disabled:opacity-50 ${style}`}
          aria-keyshortcuts={key}
        >
          <span className="flex items-center justify-between gap-2 font-semibold"><span>{label}</span><kbd className="rounded border px-1.5 text-xs">{key}</kbd></span>
          <span className="mt-1 block text-xs opacity-80">{detail}</span>
        </button>
      ))}
    </div>
  );
}
