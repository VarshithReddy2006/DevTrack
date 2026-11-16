import { useState, useEffect, useRef, useCallback } from 'react';
import { focusService, type FocusSessionModel } from '../services/focusService';

export interface UseFocusSessionReturn {
  session: FocusSessionModel | null;
  status: 'idle' | 'running' | 'paused' | 'completed';
  remainingSec: number;
  formattedTime: string;
  progressPercent: number;
  mode: string;
  isLoading: boolean;
  completedResult: FocusSessionModel | null;
  isResultDialogOpen: boolean;
  startSession: (mode: string, durationMinutes: number) => Promise<void>;
  pauseSession: () => Promise<void>;
  resumeSession: () => Promise<void>;
  completeSession: () => Promise<void>;
  abandonSession: () => Promise<void>;
  closeResultDialog: () => void;
}

export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function useFocusSession(): UseFocusSessionReturn {
  const [session, setSession] = useState<FocusSessionModel | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'paused' | 'completed'>('idle');
  const [remainingSec, setRemainingSec] = useState<number>(1500); // 25 mins default
  const [totalPlannedSec, setTotalPlannedSec] = useState<number>(1500);
  const [mode, setMode] = useState<string>('deep_work');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [completedResult, setCompletedResult] = useState<FocusSessionModel | null>(null);
  const [isResultDialogOpen, setIsResultDialogOpen] = useState<boolean>(false);

  const heartbeatTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Helper to compute server-recovered countdown
  const calculateRemainingSeconds = useCallback((s: FocusSessionModel): number => {
    const planned = s.plannedSec || 1500;
    const startTime = new Date(s.startedAt).getTime();
    const now = Date.now();
    const pausedSec = s.pausedSec || 0;

    let elapsedSec = Math.max(0, Math.floor((now - startTime) / 1000) - pausedSec);
    if (s.status === 'paused' && s.lastPausedAt) {
      const pauseDuration = Math.max(0, Math.floor((now - new Date(s.lastPausedAt).getTime()) / 1000));
      elapsedSec = Math.max(0, elapsedSec - pauseDuration);
    }

    return Math.max(0, planned - elapsedSec);
  }, []);

  // 1. Recover active focus session from server on mount
  useEffect(() => {
    let mounted = true;
    async function recoverSession() {
      setIsLoading(true);
      try {
        const active = await focusService.getActiveSession();
        if (mounted && active && (active.status === 'open' || active.status === 'paused')) {
          setSession(active);
          setMode(active.mode || 'deep_work');
          const planned = active.plannedSec || 1500;
          setTotalPlannedSec(planned);
          const rem = calculateRemainingSeconds(active);
          setRemainingSec(rem);
          setStatus(active.status === 'paused' ? 'paused' : 'running');
        }
      } catch (err) {
        console.error('[useFocusSession] Failed to recover active focus session', err);
      } finally {
        if (mounted) setIsLoading(false);
      }
    }

    recoverSession();
    return () => {
      mounted = false;
    };
  }, [calculateRemainingSeconds]);

  // 2. Countdown timer interval when running
  useEffect(() => {
    if (status !== 'running') return;

    const interval = setInterval(() => {
      setRemainingSec((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          // Auto complete on zero
          if (session?._id) {
            focusService.completeSession(session._id).then((completed) => {
              setCompletedResult(completed);
              setIsResultDialogOpen(true);
              setStatus('idle');
              setSession(null);
            });
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [status, session]);

  // 3. Heartbeat cycle (every 50 seconds during running session)
  useEffect(() => {
    if (status === 'running' && session?._id) {
      heartbeatTimerRef.current = setInterval(() => {
        focusService.recordHeartbeat(session._id);
      }, 50000);
    } else {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    }

    return () => {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
      }
    };
  }, [status, session]);

  // 4. Lifecycle Actions
  const startSession = useCallback(async (selectedMode: string, durationMinutes: number) => {
    setIsLoading(true);
    try {
      const newSession = await focusService.startSession(selectedMode, durationMinutes);
      setSession(newSession);
      setMode(selectedMode);
      const planned = (newSession.plannedSec || durationMinutes * 60);
      setTotalPlannedSec(planned);
      setRemainingSec(planned);
      setStatus('running');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const pauseSession = useCallback(async () => {
    if (!session?._id) return;
    try {
      const updated = await focusService.pauseSession(session._id);
      setSession(updated);
      setStatus('paused');
    } catch (err) {
      console.error('[useFocusSession] Failed to pause session', err);
    }
  }, [session]);

  const resumeSession = useCallback(async () => {
    if (!session?._id) return;
    try {
      const updated = await focusService.resumeSession(session._id);
      setSession(updated);
      setStatus('running');
    } catch (err) {
      console.error('[useFocusSession] Failed to resume session', err);
    }
  }, [session]);

  const completeSession = useCallback(async () => {
    if (!session?._id) return;
    setIsLoading(true);
    try {
      const completed = await focusService.completeSession(session._id);
      setCompletedResult(completed);
      setIsResultDialogOpen(true);
      setStatus('idle');
      setSession(null);
      setRemainingSec(totalPlannedSec);
    } finally {
      setIsLoading(false);
    }
  }, [session, totalPlannedSec]);

  const abandonSession = useCallback(async () => {
    if (!session?._id) {
      setStatus('idle');
      setSession(null);
      setRemainingSec(totalPlannedSec);
      return;
    }
    setIsLoading(true);
    try {
      await focusService.abandonSession(session._id);
      setStatus('idle');
      setSession(null);
      setRemainingSec(totalPlannedSec);
    } finally {
      setIsLoading(false);
    }
  }, [session, totalPlannedSec]);

  const closeResultDialog = useCallback(() => {
    setIsResultDialogOpen(false);
  }, []);

  const progressPercent = totalPlannedSec > 0
    ? Math.min(100, Math.max(0, Math.round(((totalPlannedSec - remainingSec) / totalPlannedSec) * 100)))
    : 0;

  return {
    session,
    status,
    remainingSec,
    formattedTime: formatTime(remainingSec),
    progressPercent,
    mode,
    isLoading,
    completedResult,
    isResultDialogOpen,
    startSession,
    pauseSession,
    resumeSession,
    completeSession,
    abandonSession,
    closeResultDialog,
  };
}
