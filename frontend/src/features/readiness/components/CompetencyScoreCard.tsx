import React from 'react';

export interface CompetencyDimension {
  key: string;
  label: string;
  /** Candidate score on a 0-100 scale. */
  score: number;
  /** Target role benchmark on a 0-100 scale. */
  target: number;
  percentile?: number;
  /** Short note on the biggest gap for this dimension. */
  gap?: string;
}

interface Props {
  dimension: CompetencyDimension;
  className?: string;
}

export const CompetencyScoreCard: React.FC<Props> = ({ dimension, className = '' }) => {
  const { label, score, target, percentile, gap } = dimension;
  const delta = Math.round(score - target);
  const deltaText = delta >= 0 ? `+${delta} vs target` : `${delta} vs target`;

  return (
    <div
      role="status"
      className={`rounded-xl border border-white/10 bg-slate-900/90 px-3 py-2 text-xs text-slate-100 ${className}`}
    >
      <p className="font-semibold">{label}</p>
      <p className="mt-1">
        Score {Math.round(score)}/100 <span className="text-slate-400">({deltaText})</span>
      </p>
      {percentile !== undefined && <p className="text-slate-400">Percentile {Math.round(percentile)}</p>}
      {gap && <p className="mt-1 text-slate-300">Gap: {gap}</p>}
    </div>
  );
};
