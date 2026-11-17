import { ChevronDown, ChevronUp, Minus } from 'lucide-react';

interface RankDeltaProps {
  /** Places gained (positive), lost (negative) or 0 for no change. */
  delta: number;
}

export function RankDelta({ delta }: RankDeltaProps) {
  if (delta > 0) {
    return (
      <span className="inline-flex items-center gap-0.5 font-semibold text-emerald-700" aria-label={`Up ${delta} ${delta === 1 ? 'place' : 'places'}`}>
        <ChevronUp className="h-4 w-4" aria-hidden="true" />
        <span aria-hidden="true">+{delta}</span>
      </span>
    );
  }
  if (delta < 0) {
    const lost = Math.abs(delta);
    return (
      <span className="inline-flex items-center gap-0.5 font-semibold text-red-700" aria-label={`Down ${lost} ${lost === 1 ? 'place' : 'places'}`}>
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
        <span aria-hidden="true">-{lost}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 font-semibold text-zinc-600" aria-label="No change">
      <Minus className="h-4 w-4" aria-hidden="true" />
      <span aria-hidden="true">=</span>
    </span>
  );
}
