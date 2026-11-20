import { MotionConfig, motion, useReducedMotion } from 'framer-motion';
import { Modal } from '../../../components/ui/Modal';
import { durations } from '../../../design-system/motion/transitions';
import type { SessionSummary } from '../sessionSummary';
import { RetentionDeltaBadge, SummaryCounter } from './RetentionDeltaBadge';

export function CardSummaryModal({ summary, open, onClose }: { summary: SessionSummary; open: boolean; onClose: () => void }) {
  const reducedMotion = useReducedMotion();
  return (
    <MotionConfig reducedMotion="user">
      <Modal open={open} onClose={onClose} title="Review session complete" description="Your progress and next review schedule for this deck.">
        <div className="max-h-[70vh] space-y-5 overflow-y-auto text-dt-text">
          <p className="text-lg font-semibold">{summary.total} {summary.total === 1 ? 'card' : 'cards'} reviewed</p>
          <dl className="grid grid-cols-3 gap-2 text-center">
            {(['failed', 'hard', 'easy'] as const).map(rating => (
              <div key={rating} className="rounded-xl border border-dt-primary/15 p-3">
                <dt className="text-sm text-dt-textSecondary">{rating === 'failed' ? 'Again (Failed)' : rating === 'hard' ? 'Hard' : 'Easy'}</dt>
                <dd className="mt-1 text-xl font-bold">{summary.ratings[rating]}</dd>
              </div>
            ))}
          </dl>
          {summary.retention ? <RetentionDeltaBadge {...summary.retention} /> : <p className="text-sm text-dt-textSecondary">Retention estimate unavailable for this session.</p>}
          <motion.div className="rounded-xl bg-amber-50 p-4 text-amber-900" animate={reducedMotion ? undefined : { opacity: [0.7, 1] }} transition={{ duration: durations.slow }}>
            <p className="font-semibold">Expected reward: <SummaryCounter value={summary.expectedXp} /> XP</p>
            <p className="mt-1 text-xs">5 XP per saved review. Award confirmation is unavailable.</p>
          </motion.div>
          <section aria-label="Next review forecast">
            <h3 className="font-semibold">Next review · this deck</h3>
            {summary.forecast.length ? <ul className="mt-2 space-y-1 text-sm text-dt-textSecondary">{summary.forecast.map(({ date, count }) => (
              <li key={date}>{count} {count === 1 ? 'card' : 'cards'} due <time dateTime={date}>{new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</time></li>
            ))}</ul> : <p className="mt-2 text-sm text-dt-textSecondary">Review schedule unavailable.</p>}
          </section>
          <div className="flex justify-end"><button type="button" data-dialog-initial-focus onClick={onClose} className="dt-btn dt-btn-primary">Done</button></div>
        </div>
      </Modal>
    </MotionConfig>
  );
}
