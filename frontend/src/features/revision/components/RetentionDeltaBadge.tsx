import { useEffect } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'framer-motion';
import { durations } from '../../../design-system/motion/transitions';

export function SummaryCounter({ from = 0, value }: { from?: number; value: number }) {
  const reducedMotion = useReducedMotion();
  const count = useMotionValue(from);
  const rounded = useTransform(count, Math.round);
  useEffect(() => {
    count.set(from);
    const controls = animate(count, value, { duration: reducedMotion ? 0 : durations.slow });
    return () => controls.stop();
  }, [count, from, value, reducedMotion]);
  return <span><span className="sr-only">{value}</span><motion.span aria-hidden="true">{rounded}</motion.span></span>;
}

export function RetentionDeltaBadge({ before, after }: { before: number; after: number }) {
  const delta = after - before;
  return (
    <div className="rounded-xl bg-dt-primary/10 p-4 text-dt-text">
      <p className="text-sm font-medium">Estimated retention · reviewed cards</p>
      <p className="mt-1 text-xl font-bold">
        <span className="sr-only">{`Estimated retention: ${before}% to ${after}%, ${delta > 0 ? '+' : ''}${delta} percentage points`}</span>
        <span aria-hidden="true">{before}% → <SummaryCounter from={before} value={after} />% ({delta > 0 ? '+' : ''}{delta} pp)</span>
      </p>
    </div>
  );
}
