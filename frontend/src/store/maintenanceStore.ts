// maintenanceStore.ts — app-wide maintenance mode state.
// The API client enters maintenance on HTTP 503 responses that carry Retry-After;
// MaintenanceModeScreen counts down, checks readiness and exits when the API is back.
import { create } from 'zustand';

/** Used when Retry-After is present but cannot be parsed. */
export const DEFAULT_RETRY_SECONDS = 60;
/** Never poll more often than this, even if the server asks for less. */
export const MIN_RETRY_SECONDS = 5;
/** Upper bound for a single wait, so a bad header can't hide the app for hours. */
export const MAX_RETRY_SECONDS = 3600;
/** Failed readiness checks double the wait up to this cap. */
export const MAX_BACKOFF_SECONDS = 300;

/** Retry-After is either delay-seconds or an HTTP date. Returns whole seconds, or null if unusable. */
export function parseRetryAfter(value: unknown, now = Date.now()): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

export function clampRetrySeconds(seconds: number): number {
  return Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, Math.round(seconds)));
}

interface MaintenanceState {
  active: boolean;
  /** Epoch ms of the next automatic readiness check. */
  retryAt: number | null;
  /** Length of the current wait in seconds. */
  delaySeconds: number;
  failedChecks: number;
  enter: (retryAfterSeconds: number, now?: number) => void;
  scheduleRetry: (now?: number) => void;
  exit: () => void;
}

export const useMaintenanceStore = create<MaintenanceState>((set, get) => ({
  active: false,
  retryAt: null,
  delaySeconds: DEFAULT_RETRY_SECONDS,
  failedChecks: 0,
  enter: (retryAfterSeconds, now = Date.now()) => {
    // Other requests failing during the outage must not restart the countdown.
    if (get().active) return;
    const delaySeconds = clampRetrySeconds(retryAfterSeconds);
    set({ active: true, delaySeconds, retryAt: now + delaySeconds * 1000, failedChecks: 0 });
  },
  scheduleRetry: (now = Date.now()) => {
    const { active, delaySeconds, failedChecks } = get();
    if (!active) return;
    const next = Math.min(delaySeconds * 2, Math.max(delaySeconds, MAX_BACKOFF_SECONDS));
    set({ delaySeconds: next, retryAt: now + next * 1000, failedChecks: failedChecks + 1 });
  },
  exit: () => set({ active: false, retryAt: null, delaySeconds: DEFAULT_RETRY_SECONDS, failedChecks: 0 }),
}));

/** Called by the API client. Only a 503 that says when to retry counts as maintenance. */
export function reportServiceUnavailable(retryAfterHeader: unknown): void {
  if (retryAfterHeader === undefined || retryAfterHeader === null || retryAfterHeader === '') return;
  const seconds = parseRetryAfter(retryAfterHeader) ?? DEFAULT_RETRY_SECONDS;
  useMaintenanceStore.getState().enter(seconds);
}
