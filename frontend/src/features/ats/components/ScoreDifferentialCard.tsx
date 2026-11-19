import { motion } from 'framer-motion';
import { ScoreRadialDial } from './ScoreRadialDial';

export interface CategoryBreakdown {
  name: string;
  score: number; // 0 to 100
  tooltip?: string;
}

export interface ScoreDifferentialCardProps {
  currentScore: number;
  originalScore?: number;
  delta?: number;
  categories?: CategoryBreakdown[];
  impactMetricsScore?: number;
  actionVerbsScore?: number;
  keywordDensityScore?: number;
  isFloating?: boolean;
  className?: string;
  title?: string;
}

const DEFAULT_TOOLTIPS: Record<string, string> = {
  'Impact Metrics': 'Quantified achievements with measurable metrics, percentages, or numbers.',
  'Action Verbs': 'Strong resume action verbs opening each bullet point.',
  'Keyword Density': 'Alignment and coverage against targeted job requirements and skills.',
};

function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta} points`;
  if (delta < 0) return `${delta} points`;
  return '0 points';
}

function getDeltaStyles(delta: number): {
  container: string;
  badge: string;
  label: string;
  pulseClass: string;
} {
  if (delta > 0) {
    return {
      container: 'border-emerald-200 bg-emerald-50/50',
      badge: 'border-emerald-200 bg-emerald-50 text-emerald-800',
      label: 'Score Gain',
      pulseClass: 'animate-pulse',
    };
  }
  if (delta < 0) {
    return {
      container: 'border-amber-200 bg-amber-50/50',
      badge: 'border-amber-200 bg-amber-50 text-amber-800',
      label: 'Score Drop',
      pulseClass: 'animate-pulse',
    };
  }
  return {
    container: 'border-slate-200 bg-slate-50/50',
    badge: 'border-slate-200 bg-slate-100 text-slate-700',
    label: 'No Change',
    pulseClass: '',
  };
}

function getCategoryColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 60) return 'bg-amber-500';
  return 'bg-rose-500';
}

export function ScoreDifferentialCard({
  currentScore,
  originalScore,
  delta: explicitDelta,
  categories: explicitCategories,
  impactMetricsScore,
  actionVerbsScore,
  keywordDensityScore,
  isFloating = false,
  className = '',
  title = 'Live ATS Score Differential',
}: ScoreDifferentialCardProps) {
  const effectiveDelta =
    explicitDelta !== undefined
      ? explicitDelta
      : originalScore !== undefined
      ? currentScore - originalScore
      : 0;

  const categories: CategoryBreakdown[] = explicitCategories ?? [
    {
      name: 'Impact Metrics',
      score: impactMetricsScore ?? 0,
      tooltip: DEFAULT_TOOLTIPS['Impact Metrics'],
    },
    {
      name: 'Action Verbs',
      score: actionVerbsScore ?? 0,
      tooltip: DEFAULT_TOOLTIPS['Action Verbs'],
    },
    {
      name: 'Keyword Density',
      score: keywordDensityScore ?? 0,
      tooltip: DEFAULT_TOOLTIPS['Keyword Density'],
    },
  ];

  const deltaStyles = getDeltaStyles(effectiveDelta);
  const floatingStyles = isFloating ? 'sticky top-4 z-10 shadow-lg' : 'shadow-sm';

  return (
    <aside
      aria-label="ATS Score Differential Card"
      className={`rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 transition-all ${floatingStyles} ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 pb-4 border-b border-slate-100">
        <h2 className="text-base font-semibold tracking-tight text-slate-900">
          {title}
        </h2>
        {/* Animated Delta Pill */}
        <motion.div
          key={effectiveDelta}
          initial={{ scale: 0.9, opacity: 0.8 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 15 }}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${deltaStyles.badge} ${deltaStyles.pulseClass}`}
          role="status"
          aria-label={`Score change: ${formatDelta(effectiveDelta)}`}
        >
          <span>{formatDelta(effectiveDelta)}</span>
        </motion.div>
      </div>

      {/* Main Dial & Score Display */}
      <div className="flex items-center justify-center py-5">
        <ScoreRadialDial score={currentScore} size={130} strokeWidth={11} />
      </div>

      {/* Category Breakdowns */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between text-xs font-medium text-slate-500 uppercase tracking-wider">
          <span>Category Breakdown</span>
          <span>Score</span>
        </div>

        <div className="space-y-3">
          {categories.map((category) => {
            const clampedScore = Math.max(0, Math.min(100, Math.round(category.score)));
            const barColor = getCategoryColor(clampedScore);
            const tooltip = category.tooltip ?? DEFAULT_TOOLTIPS[category.name];

            return (
              <div
                key={category.name}
                className="space-y-1.5"
                title={tooltip}
                aria-describedby={tooltip ? `tooltip-${category.name}` : undefined}
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-slate-700 flex items-center gap-1">
                    {category.name}
                  </span>
                  <span className="font-semibold text-slate-900 tabular-nums">
                    {clampedScore}%
                  </span>
                </div>

                {/* Accessible Category Progress Bar */}
                <div
                  role="progressbar"
                  aria-label={category.name}
                  aria-valuenow={clampedScore}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
                >
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${clampedScore}%` }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                    className={`h-full rounded-full ${barColor}`}
                  />
                </div>

                {tooltip && (
                  <p
                    id={`tooltip-${category.name}`}
                    className="text-[11px] text-slate-500 line-clamp-1"
                  >
                    {tooltip}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
