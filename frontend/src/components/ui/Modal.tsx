import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../../lib/design-system/tokens.css';
import { useId } from 'react';
import { useDialogFocus } from './useDialogFocus';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const sizes = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

export function Modal({ open, onClose, title, description, children, size = 'md' }: ModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const titleId = useId();
  const descriptionId = useId();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[1050] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            className={cn('w-full bg-white border border-zinc-200 rounded-xl shadow-2xl overflow-hidden', sizes[size])}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={title ? undefined : description || 'Dialog'}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
          >
            {(title || description) && (
              <div className="px-5 pt-5 pb-3 border-b border-zinc-100">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    {title && <h2 id={titleId} className="text-lg font-semibold text-[#0F172A]">{title}</h2>}
                    {description && <p id={descriptionId} className="text-sm text-zinc-500 mt-1">{description}</p>}
                  </div>
                  <button type="button" onClick={onClose} aria-label="Close dialog" className="p-1 text-zinc-400 hover:text-zinc-600">
                    <X size={18} />
                  </button>
                </div>
              </div>
            )}
            <div className="p-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
