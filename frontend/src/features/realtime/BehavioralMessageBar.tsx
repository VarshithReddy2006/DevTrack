// src/features/realtime/BehavioralMessageBar.tsx — Thin bar component for behavioral messages
// Tone-driven styling, displays behavioral messages from SSE

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Info, Sparkles, Heart, Zap } from 'lucide-react';
import { useSse } from '../../hooks/useSse';
import { cn } from '../../lib/design-system/tokens.css';

interface BehavioralMessage {
  messageId?: string;
  id?: string;
  tone: 'encouraging' | 'calm' | 'celebratory' | 'gentle-nudge' | 'supportive' | 'silent';
  text: string;
  action?: {
    label: string;
    route: string;
  };
  expiresAt?: string;
}

const TONE_STYLES: Record<string, { bg: string; border: string; text: string; icon: React.ReactNode }> = {
  encouraging: {
    bg: 'bg-emerald-50/90 backdrop-blur-md',
    border: 'border-emerald-200/50',
    text: 'text-emerald-700',
    icon: <Sparkles className="w-4 h-4 text-emerald-500" />,
  },
  calm: {
    bg: 'bg-blue-50/90 backdrop-blur-md',
    border: 'border-blue-200/50',
    text: 'text-blue-700',
    icon: <Info className="w-4 h-4 text-blue-500" />,
  },
  celebratory: {
    bg: 'bg-amber-50/90 backdrop-blur-md',
    border: 'border-amber-200/50',
    text: 'text-amber-700',
    icon: <Zap className="w-4 h-4 text-amber-500" />,
  },
  'gentle-nudge': {
    bg: 'bg-orange-50/90 backdrop-blur-md',
    border: 'border-orange-200/50',
    text: 'text-orange-700',
    icon: <Info className="w-4 h-4 text-orange-500" />,
  },
  supportive: {
    bg: 'bg-violet-50/90 backdrop-blur-md',
    border: 'border-violet-200/50',
    text: 'text-violet-700',
    icon: <Heart className="w-4 h-4 text-violet-500" />,
  },
  silent: {
    bg: 'bg-slate-50/90 backdrop-blur-md',
    border: 'border-slate-200/50',
    text: 'text-slate-600',
    icon: <Info className="w-4 h-4 text-slate-400" />,
  },
};

export function BehavioralMessageBar() {
  const { eventHistory } = useSse();
  const navigate = useNavigate();
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());

  const activeMessage = eventHistory.find((event) => {
    if (event.type !== 'behavioral_message' || !event.stats) return false;
    const message = event.stats as BehavioralMessage;
    const id = message.messageId ?? message.id;
    return id && !dismissedIds.has(id) &&
      (!message.expiresAt || Date.parse(message.expiresAt) > Date.now());
  });

  if (!activeMessage) return null;

  const message = activeMessage.stats as BehavioralMessage;
  const messageId = message.messageId ?? message.id;
  const action = message.action;
  const style = TONE_STYLES[message.tone] || TONE_STYLES.calm;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.3 }}
        className={cn(
          'fixed top-0 left-0 right-0 z-40 px-4 py-3',
          style.bg,
          'border-b',
          style.border
        )}
      >
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          {style.icon}
          <p className={cn('text-sm font-medium', style.text)}>{message.text}</p>
          {action && (
            <button
              type="button"
              onClick={() => navigate(action.route)}
              className={cn(
                'text-xs font-medium px-3 py-1 rounded-full',
                style.border,
                'border',
                style.text,
                'hover:opacity-80 transition-opacity'
              )}
            >
              {action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (messageId) setDismissedIds((ids) => new Set([...ids, messageId]));
            }}
            className="ml-auto text-slate-400 hover:text-slate-600 transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
