import type { ConnectionStatus } from '../../hooks/useSse';

/** WAN-tolerant latency bands: under 400ms is healthy, 400–1200ms is elevated, above 1200ms is poor. */
export const GOOD_LATENCY_MS = 400;
export const POOR_LATENCY_MS = 1200;
/** The server sends a heartbeat every 25s; 30s without one or any event counts as delayed. */
export const HEARTBEAT_STALE_MS = 30_000;

export type NetworkHealthLevel = 'healthy' | 'degraded' | 'poor' | 'offline';

export interface NetworkHealthInput {
  status: ConnectionStatus;
  pingMs: number | null;
  /** True when the most recent ping failed outright. */
  pingFailed: boolean;
  lastHeartbeatAt: number | null;
  lastEventAt: number | null;
  now: number;
}

export interface NetworkHealth {
  level: NetworkHealthLevel;
  /** Short text for the pill, e.g. "28ms" or "Offline". */
  label: string;
  /** Why the connection isn't healthy, for the popover. Null when healthy. */
  reason: string | null;
  heartbeatStale: boolean;
}

export function isHeartbeatStale(lastHeartbeatAt: number | null, lastEventAt: number | null, now: number): boolean {
  // Servers that never send heartbeat events can't be judged; an idle stream is not a stall.
  if (lastHeartbeatAt === null) return false;
  const lastAlive = Math.max(lastHeartbeatAt, lastEventAt ?? 0);
  return now - lastAlive > HEARTBEAT_STALE_MS;
}

export function getNetworkHealth({ status, pingMs, pingFailed, lastHeartbeatAt, lastEventAt, now }: NetworkHealthInput): NetworkHealth {
  if (status !== 'connected') {
    const label = status === 'reconnecting' ? 'Reconnecting…' : status === 'connecting' ? 'Connecting…' : 'Offline';
    return { level: 'offline', label, reason: 'Live updates are disconnected.', heartbeatStale: false };
  }

  const heartbeatStale = isHeartbeatStale(lastHeartbeatAt, lastEventAt, now);
  const pingLabel = pingMs === null ? 'Live' : `${pingMs}ms`;

  if (pingFailed) {
    return { level: 'degraded', label: 'Live', reason: "The API didn't answer the last ping.", heartbeatStale };
  }
  if (pingMs !== null && pingMs > POOR_LATENCY_MS) {
    return { level: 'poor', label: pingLabel, reason: 'Latency to the API is high.', heartbeatStale };
  }
  if (heartbeatStale) {
    return { level: 'degraded', label: pingLabel, reason: 'No heartbeat from the live stream for over 30 seconds.', heartbeatStale };
  }
  if (pingMs !== null && pingMs >= GOOD_LATENCY_MS) {
    return { level: 'degraded', label: pingLabel, reason: 'Latency to the API is elevated.', heartbeatStale };
  }
  return { level: 'healthy', label: pingLabel, reason: null, heartbeatStale };
}

/** "just now", "12s ago", "4m ago", "2h ago". */
export function formatAgo(timestamp: number | null, now: number): string {
  if (timestamp === null) return 'Never';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** "45s", "12m", "3h 5m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
