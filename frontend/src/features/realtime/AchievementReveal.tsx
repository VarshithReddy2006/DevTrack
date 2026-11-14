import { motion } from 'framer-motion';
import { Trophy, X, Sparkles } from 'lucide-react';
import { useDialogFocus } from '../../components/ui/useDialogFocus';
import { smooth } from '../../design-system/motion';
import { copy } from '../../lib/copy';

interface AchievementRevealProps {
  open: boolean;
  name?: string;
  rarity?: string;
  onDismiss: () => void;
}

/** Premium calm unlock moment — emotionally intelligent, no pressure */
export function AchievementReveal({ open, name, rarity, onDismiss }: AchievementRevealProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onDismiss);
  if (!open || !name) return null;

  const rarityColors = {
    common: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20',
    rare: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    epic: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
    legendary: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  };

  const colorClass = rarity ? rarityColors[rarity as keyof typeof rarityColors] || rarityColors.common : rarityColors.common;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={smooth}
      className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center p-4 bg-black/30 backdrop-blur-sm"
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Achievement unlocked: ${name}`}
      onClick={onDismiss}
    >
      <motion.div
        initial={{ opacity: 0, y: 32, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={smooth}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <motion.div
              initial={{ scale: 0, rotate: -180 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.1, ...smooth }}
              className={`p-3 rounded-xl ${colorClass.split(' ').slice(1).join(' ')} relative`}
            >
              <motion.div
                animate={{ rotate: [0, 5, -5, 0] }}
                transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
              >
                <Sparkles className="w-6 h-6 absolute -top-1 -right-1 opacity-60" />
              </motion.div>
              <Trophy className={`w-6 h-6 ${colorClass.split(' ')[0]}`} />
            </motion.div>
            <div>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.15 }}
                className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium"
              >
                Milestone reached
              </motion.p>
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="text-lg font-semibold text-[#0F172A] tracking-tight"
              >
                {name}
              </motion.p>
              {rarity && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.25 }}
                  className="text-xs text-zinc-500 mt-1 capitalize font-medium"
                >
                  {rarity}
                </motion.p>
              )}
            </div>
          </div>
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            type="button"
            onClick={onDismiss}
            className="p-2 text-zinc-400 hover:text-zinc-600 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#12B76A]/50 transition-colors"
            aria-label="Dismiss"
            data-dialog-initial-focus
          >
            <X size={18} />
          </motion.button>
        </div>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
          className="mt-5 text-sm text-zinc-500 leading-relaxed"
        >
          {copy.toast.achievement}
        </motion.p>
      </motion.div>
    </motion.div>
  );
}
