import { useId } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronRight } from 'lucide-react';
import { useDialogFocus } from '../../../components/ui/useDialogFocus';
import { bouncy, prefersReducedMotion } from '../../../design-system/motion';
import { divisionLabel, promotionPerks } from '../leagueUtils';
import { useLeaguePromotion, type ActiveLeaguePromotion } from '../useLeaguePromotion';
import { TierBadgeEvolution } from './TierBadgeEvolution';

interface LeaguePromotionModalProps {
  promotion: ActiveLeaguePromotion | null;
  /** Records that the user has seen the promotion and closes the modal. */
  onClaim: () => void;
}

function PromotionDialog({ promotion, onClaim }: { promotion: ActiveLeaguePromotion; onClaim: () => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClaim);
  const titleId = useId();
  const descriptionId = useId();
  const toLabel = divisionLabel(promotion.to);
  const perks = promotionPerks(promotion.to, promotion.promotionSlots, promotion.cohortSize);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[1050] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClaim}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 16 }}
        animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={bouncy}
        className="w-full max-w-md overflow-hidden rounded-3xl border border-amber-200 bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="bg-gradient-to-b from-amber-50 to-white px-6 pb-2 pt-8 sm:px-8">
          <TierBadgeEvolution from={promotion.from} to={promotion.to} />
        </div>
        <div className="px-6 pb-6 pt-4 text-center sm:px-8">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-600">League promotion</p>
          <h2 id={titleId} className="mt-1 text-2xl font-black tracking-tight text-zinc-900">Welcome to {toLabel} League</h2>
          <p id={descriptionId} className="mt-2 text-sm text-zinc-600">
            Congratulations! You finished in the promotion zone and moved up from {divisionLabel(promotion.from)} to {toLabel}.
          </p>
          <div className="mt-5 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-left">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">What's new for you</h3>
            <ul className="mt-2 space-y-2">
              {perks.map((perk) => (
                <li key={perk} className="flex items-start gap-2 text-sm text-zinc-700">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                  <span>{perk}</span>
                </li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            data-dialog-initial-focus
            onClick={onClaim}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 px-6 py-3 text-sm font-bold text-white shadow-md transition hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
          >
            Claim Rewards & Continue
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** Celebration shown once after the user's league tier goes up. */
export function LeaguePromotionModal({ promotion, onClaim }: LeaguePromotionModalProps) {
  return <AnimatePresence>{promotion && <PromotionDialog key={promotion.to} promotion={promotion} onClaim={onClaim} />}</AnimatePresence>;
}

/** App-level connector: checks the user's league on session start and celebrates promotions. */
export function LeaguePromotionCelebration() {
  const { promotion, acknowledge } = useLeaguePromotion();
  return <LeaguePromotionModal promotion={promotion} onClaim={acknowledge} />;
}
