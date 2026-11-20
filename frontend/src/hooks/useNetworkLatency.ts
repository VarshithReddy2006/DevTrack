import { useCallback, useEffect, useRef, useState } from 'react';
import { envConfig } from '../utils/envCheck';

export const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 5_000;
/** Ignore extra ping requests that arrive this soon after the last one. */
const MIN_PING_GAP_MS = 5_000;

function healthUrl(): string {
  // /health sits at the server root, outside the /api base path.
  return new URL('/health', new URL(envConfig.VITE_API_BASE_URL, window.location.origin)).toString();
}

export interface NetworkLatency {
  pingMs: number | null;
  lastPingAt: number | null;
  /** The latest ping failed (network error, timeout or non-2xx). */
  failed: boolean;
  /** Ping now unless one is running or one finished in the last few seconds. */
  pingNow: () => void;
}

/**
 * Measures round-trip time to the API with a lightweight HEAD /health every 30s.
 * Pings pause while the tab is hidden and resume (with an immediate ping) when it is shown.
 */
export function useNetworkLatency(enabled: boolean): NetworkLatency {
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [lastPingAt, setLastPingAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const lastStartedAt = useRef(0);
  const mounted = useRef(true);

  const ping = useCallback(async (force: boolean) => {
    if (inFlight.current) return;
    if (!force && Date.now() - lastStartedAt.current < MIN_PING_GAP_MS) return;
    inFlight.current = true;
    lastStartedAt.current = Date.now();
    const started = performance.now();
    try {
      const response = await fetch(healthUrl(), {
        method: 'HEAD',
        cache: 'no-store',
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!mounted.current) return;
      if (!response.ok) throw new Error(`health returned ${response.status}`);
      setPingMs(Math.round(performance.now() - started));
      setFailed(false);
    } catch {
      if (!mounted.current) return;
      setPingMs(null);
      setFailed(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) setLastPingAt(Date.now());
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setPingMs(null);
      setFailed(false);
      return;
    }

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (force: boolean) => {
      if (timer !== null) return;
      // Quick tab switching shouldn't fire a ping each time, so resumes are debounced.
      void ping(force);
      timer = setInterval(() => void ping(true), PING_INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start(false));

    if (!document.hidden) start(true);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, ping]);

  const pingNow = useCallback(() => { void ping(false); }, [ping]);

  return { pingMs, lastPingAt, failed, pingNow };
}
