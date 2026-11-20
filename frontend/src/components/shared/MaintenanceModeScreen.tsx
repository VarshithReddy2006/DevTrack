import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Wrench } from 'lucide-react';
import { useDialogFocus } from '../ui/useDialogFocus';
import { checkApiReady } from '../../services/systemHealthService';
import { useMaintenanceStore } from '../../store/maintenanceStore';

const ignoreEscape = () => { /* maintenance can't be dismissed, only waited out */ };

export function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function MaintenanceOverlay({ retryAt, failedChecks }: { retryAt: number; failedChecks: number }) {
  const queryClient = useQueryClient();
  const exit = useMaintenanceStore((state) => state.exit);
  const scheduleRetry = useMaintenanceStore((state) => state.scheduleRetry);
  const dialogRef = useDialogFocus<HTMLDivElement>(ignoreEscape);
  const titleId = useId();
  const descriptionId = useId();
  const [now, setNow] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    const ready = await checkApiReady();
    checkingRef.current = false;
    setChecking(false);
    if (ready) {
      exit();
      // The app stayed mounted underneath, so refetching its queries restores the view.
      void queryClient.invalidateQueries();
    } else {
      scheduleRetry();
      setNow(Date.now());
    }
  }, [exit, scheduleRetry, queryClient]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));

  useEffect(() => {
    if (remaining === 0) void check();
  }, [remaining, check]);

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-8 text-center shadow-2xl"
      >
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/30">
          <Wrench className="h-10 w-10 text-white" aria-hidden="true" />
        </div>
        <h2 id={titleId} className="mt-6 text-2xl font-bold tracking-tight text-zinc-900">We'll be right back</h2>
        <p id={descriptionId} className="mt-2 text-sm text-zinc-600">
          DevTrack is undergoing scheduled upgrades. Your work is safe, and this page will pick up where you left off once we're back.
        </p>

        <div className="mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Checking again in</p>
          <p role="timer" className="mt-1 font-mono text-3xl font-bold tabular-nums text-zinc-900">{formatCountdown(remaining)}</p>
        </div>

        <p aria-live="polite" className="mt-3 min-h-5 text-xs text-zinc-500">
          {checking ? 'Checking whether DevTrack is back…' : failedChecks > 0 ? 'Still upgrading. We\'ll keep checking, a little less often each time.' : ''}
        </p>

        <button
          type="button"
          data-dialog-initial-focus
          onClick={() => void check()}
          disabled={checking}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        >
          <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
          {checking ? 'Checking…' : 'Check Again Now'}
        </button>
      </div>
    </div>
  );
}

/** Full-screen notice shown while the API reports planned maintenance (HTTP 503 with Retry-After). */
export function MaintenanceModeScreen() {
  const active = useMaintenanceStore((state) => state.active);
  const retryAt = useMaintenanceStore((state) => state.retryAt);
  const failedChecks = useMaintenanceStore((state) => state.failedChecks);
  if (!active || retryAt === null) return null;
  return <MaintenanceOverlay retryAt={retryAt} failedChecks={failedChecks} />;
}
