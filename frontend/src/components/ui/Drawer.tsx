import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../../lib/design-system/tokens.css';
import { useId } from 'react';
import { useDialogFocus } from './useDialogFocus';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  side?: 'left' | 'right';
  children: React.ReactNode;
  className?: string;
}

export function Drawer({ open, onClose, title, side = 'right', children, className }: DrawerProps) {
  const from = side === 'right' ? '100%' : '-100%';
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const titleId = useId();

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[1040] bg-black/55"
            onClick={onClose}
          />
          <motion.aside
            ref={dialogRef}
            initial={{ x: from }}
            animate={{ x: 0 }}
            exit={{ x: from }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
            className={cn(
              'fixed top-0 h-full w-full max-w-md z-[1050] bg-zinc-950 border-zinc-800 flex flex-col shadow-2xl',
              side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
              className
            )}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={title ? undefined : 'Drawer'}
            tabIndex={-1}
          >
            {title && (
              <div className="h-14 px-4 flex items-center justify-between border-b border-zinc-800 shrink-0">
                <h2 id={titleId} className="font-semibold text-sm">{title}</h2>
                <button type="button" onClick={onClose} className="p-2 text-zinc-500 hover:text-zinc-300" aria-label="Close">
                  <X size={18} />
                </button>
              </div>
            )}
            <motion.div layout className="flex-1 overflow-y-auto">{children}</motion.div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
