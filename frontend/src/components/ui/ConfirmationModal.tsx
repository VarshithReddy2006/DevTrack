import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';
import { useDialogFocus } from './useDialogFocus';

export interface ConfirmationModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  type?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  type = 'warning',
  onConfirm,
  onCancel,
}) => {
  const dialogRef = useDialogFocus<HTMLDivElement>(onCancel);
  const titleId = React.useId();
  const messageId = React.useId();
  // Prevent clicks on overlay from bubbling
  const handleContentClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const colors = {
    danger: {
      iconBg: 'bg-rose-50 border-rose-100 text-rose-500',
      confirmBtn: 'bg-rose-500 hover:bg-rose-600 hover:shadow-rose-500/10 focus:ring-rose-500/20 text-white',
    },
    warning: {
      iconBg: 'bg-amber-50 border-amber-100 text-amber-500',
      confirmBtn: 'bg-amber-500 hover:bg-amber-600 hover:shadow-amber-500/10 focus:ring-amber-500/20 text-white',
    },
    info: {
      iconBg: 'bg-violet-50 border-violet-100 text-[#8B5CF6]',
      confirmBtn: 'bg-[#8B5CF6] hover:bg-[#7C3AED] hover:shadow-violet-500/10 focus:ring-violet-500/20 text-white',
    },
  }[type];

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Backdrop Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-black/25 backdrop-blur-md"
            onClick={onCancel}
          />

          {/* Modal Card */}
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: 'spring', damping: 25, stiffness: 350 }}
            onClick={handleContentClick}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={messageId}
            tabIndex={-1}
            className="relative w-full max-w-md bg-white border border-slate-200/80 rounded-2xl shadow-2xl p-6 overflow-hidden z-10"
          >
            {/* Close Button */}
            <button
              onClick={onCancel}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-all duration-200"
              aria-label="Close modal"
            >
              <X size={16} />
            </button>

            {/* Icon & Content */}
            <div className="flex gap-4 items-start pr-6 mt-1">
              <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 shadow-sm ${colors.iconBg}`}>
                <AlertTriangle size={20} />
              </div>
              <div className="flex-1">
                <h3 id={titleId} className="text-base font-bold text-slate-800 tracking-tight leading-snug">
                  {title}
                </h3>
                <p id={messageId} className="mt-2 text-xs font-semibold text-slate-500 leading-relaxed">
                  {message}
                </p>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
              <button
                type="button"
                data-dialog-initial-focus
                onClick={onCancel}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-500 hover:text-slate-800 hover:bg-slate-50 border border-slate-200 transition-all duration-200"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className={`px-5 py-2 rounded-xl text-xs font-bold shadow-md transition-all duration-250 hover:-translate-y-0.5 active:translate-y-0 ${colors.confirmBtn}`}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
