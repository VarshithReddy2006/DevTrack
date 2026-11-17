// src/features/realtime/RecoveryOverlay.tsx — Recovery surfaces for the realtime layer
// 1. Gentle full-page overlay on comeback (user returns after inactivity)
// 2. Small status banner while the SSE connection is down, with a retry countdown

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Sparkles, WifiOff } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { reconnectNow, useSse } from '../../hooks/useSse';
import { useUserStore } from '../../store/userStore';
import { cn } from '../../lib/design-system/tokens.css';
import { copy } from '../../lib/copy';

interface RecoveryMessage {
  id: string;
  tone: string;
  text: string;
  action?: {
    label: string;
    route: string;
  };
  expiresAt: string;
}

const CONNECTED_MESSAGE_MS = 1_500;
const RUNTIME_STATE_QUERY_KEY = ['runtime-state'] as const;

/** Whole seconds left until `nextReconnectAt`, never negative. */
export function secondsUntil(nextReconnectAt: number, now: number): number {
  return Math.max(0, Math.ceil((nextReconnectAt - now) / 1000));
}

export function ConnectionRecoveryBanner() {
  const isAuthenticated = useUserStore((s) => s.isAuthenticated);
  const { connectionStatus, nextReconnectAt } = useSse();
  const queryClient = useQueryClient();
  // `interrupted` stays true from the first drop until the "Connected!" message is gone,
  // so the first connect after page load (status 'connecting') never shows a banner.
  const [interrupted, setInterrupted] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isAuthenticated) {
      setInterrupted(false);
      setRecovered(false);
      return;
    }
    if (connectionStatus === 'reconnecting') {
      setInterrupted(true);
      setRecovered(false);
    } else if (connectionStatus === 'connected' && interrupted && !recovered) {
      setRecovered(true);
      // Events missed while offline are gone, so pull the runtime state fresh.
      void queryClient.invalidateQueries({ queryKey: RUNTIME_STATE_QUERY_KEY });
    }
  }, [isAuthenticated, connectionStatus, interrupted, recovered, queryClient]);

  useEffect(() => {
    if (!recovered) return;
    const timer = setTimeout(() => {
      setRecovered(false);
      setInterrupted(false);
    }, CONNECTED_MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [recovered]);

  const waiting = connectionStatus === 'reconnecting' && nextReconnectAt !== null;
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [waiting, nextReconnectAt]);

  if (!isAuthenticated) return null;

  const showBanner = interrupted && (recovered || connectionStatus !== 'connected');
  const seconds = waiting && nextReconnectAt !== null ? secondsUntil(nextReconnectAt, now) : 0;
  const attemptInFlight = connectionStatus === 'connecting' || (waiting && seconds === 0);

  // The live region stays mounted so screen readers pick up the text changes inside it.
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 px-4">
      <AnimatePresence>
        {showBanner && (
          <motion.div
            key="connection-banner"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.25 }}
            className="pointer-events-auto flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm shadow-lg"
          >
            {recovered ? (
              <p className="font-medium text-[#12B76A]">Connected!</p>
            ) : (
              <>
                <WifiOff className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
                <div className="text-zinc-700">
                  {connectionStatus === 'disconnected' ? (
                    <p>Live updates paused. We could not reach the server.</p>
                  ) : (
                    <p>
                      Reconnecting to live server...
                      {waiting && !attemptInFlight && (
                        // Hidden from the live region so it does not announce every second.
                        <span aria-hidden="true"> Next attempt in {seconds}s</span>
                      )}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={reconnectNow}
                  disabled={attemptInFlight}
                  className="rounded-lg border border-zinc-200 px-3 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                >
                  Reconnect Now
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function RecoveryOverlay() {
  return (
    <>
      <ConnectionRecoveryBanner />
      <ComebackOverlay />
    </>
  );
}

function ComebackOverlay() {
  const { eventHistory } = useSse();

  // Filter for comeback messages
  const comebackMessages = eventHistory.filter(
    (event) => event.type === 'behavioral_message' && (event.stats as { context?: string })?.context === 'comeback'
  ) as Array<{ type: string; stats: RecoveryMessage; timestamp: string }>;

  // Get the most recent non-expired comeback message
  const activeMessage = comebackMessages.find((msg) => {
    const expiresAt = new Date(msg.stats.expiresAt);
    return expiresAt > new Date();
  });

  if (!activeMessage) return null;

  const { stats: message } = activeMessage;

  const handleDismiss = () => {
    // In production, track dismissed messages in local storage
    // For now, just let the user dismiss by clicking outside
  };

  const handleAction = () => {
    if (message.action) {
      window.location.href = message.action.route;
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.5 }}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={handleDismiss}
        role="dialog"
        aria-modal="true"
        aria-label="Welcome back"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="fixed inset-0 flex items-center justify-center p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-white border border-zinc-200 rounded-2xl p-8 max-w-md w-full shadow-2xl relative overflow-hidden">
            {/* Decorative gradient */}
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#12B76A] via-teal-500 to-[#12B76A]" />
            
            {/* Icon */}
            <div className="flex justify-center mb-6">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
                className="w-16 h-16 rounded-full bg-[#12B76A]/10 flex items-center justify-center"
              >
                <Sparkles className="w-8 h-8 text-[#12B76A]" />
              </motion.div>
            </div>

            {/* Content */}
            <div className="text-center mb-8">
              <h2 className="text-2xl font-semibold text-[#0F172A] mb-2">{copy.comeback.title}</h2>
              <p className="text-zinc-500 leading-relaxed">{message.text || copy.comeback.subtitle}</p>
            </div>

            {/* Action */}
            <div className="flex gap-3">
              <button
                onClick={handleDismiss}
                className="flex-1 px-4 py-3 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 transition-colors text-sm font-medium"
              >
                Maybe later
              </button>
              <button
                onClick={handleAction}
                className={cn(
                  'flex-1 px-4 py-3 rounded-lg bg-[#12B76A] text-white hover:bg-[#0e9f5d] transition-colors text-sm font-medium flex items-center justify-center gap-2'
                )}
              >
                {message.action?.label || copy.comeback.cta}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            {/* Dismiss hint */}
            <p className="text-xs text-zinc-400 text-center mt-4">Click outside to dismiss</p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
