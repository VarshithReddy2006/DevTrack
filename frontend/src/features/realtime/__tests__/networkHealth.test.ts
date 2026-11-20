import { describe, expect, it } from 'vitest';
import { formatAgo, formatDuration, getNetworkHealth, isHeartbeatStale, type NetworkHealthInput } from '../networkHealth';

const NOW = 1_000_000;
const base: NetworkHealthInput = { status: 'connected', pingMs: 28, pingFailed: false, lastHeartbeatAt: NOW - 5_000, lastEventAt: null, now: NOW };

describe('getNetworkHealth', () => {
  it('uses the latency bands: green under 100ms, amber to 300ms, red above', () => {
    expect(getNetworkHealth(base)).toMatchObject({ level: 'healthy', label: '28ms', reason: null });
    expect(getNetworkHealth({ ...base, pingMs: 99 }).level).toBe('healthy');
    expect(getNetworkHealth({ ...base, pingMs: 100 }).level).toBe('degraded');
    expect(getNetworkHealth({ ...base, pingMs: 180 })).toMatchObject({ level: 'degraded', label: '180ms' });
    expect(getNetworkHealth({ ...base, pingMs: 300 }).level).toBe('degraded');
    expect(getNetworkHealth({ ...base, pingMs: 301 })).toMatchObject({ level: 'poor', label: '301ms' });
  });

  it('shows the live stream state immediately when it is not connected', () => {
    expect(getNetworkHealth({ ...base, status: 'disconnected' })).toMatchObject({ level: 'offline', label: 'Offline' });
    expect(getNetworkHealth({ ...base, status: 'reconnecting' })).toMatchObject({ level: 'offline', label: 'Reconnecting…' });
    expect(getNetworkHealth({ ...base, status: 'connecting' })).toMatchObject({ level: 'offline', label: 'Connecting…' });
  });

  it('turns amber when the heartbeat is more than 30s late', () => {
    const stale = getNetworkHealth({ ...base, lastHeartbeatAt: NOW - 31_000 });
    expect(stale).toMatchObject({ level: 'degraded', heartbeatStale: true });
    expect(stale.reason).toMatch(/heartbeat/);
  });

  it('turns amber when the ping fails while the stream is up', () => {
    expect(getNetworkHealth({ ...base, pingMs: null, pingFailed: true })).toMatchObject({ level: 'degraded', label: 'Live' });
  });

  it('shows Live before the first ping finishes', () => {
    expect(getNetworkHealth({ ...base, pingMs: null })).toMatchObject({ level: 'healthy', label: 'Live' });
  });
});

describe('isHeartbeatStale', () => {
  it('cannot judge a stream before its first heartbeat', () => {
    expect(isHeartbeatStale(null, null, NOW)).toBe(false);
  });

  it('counts a recent event as proof the stream is alive', () => {
    expect(isHeartbeatStale(NOW - 60_000, NOW - 1_000, NOW)).toBe(false);
    expect(isHeartbeatStale(NOW - 30_000, null, NOW)).toBe(false);
    expect(isHeartbeatStale(NOW - 30_001, null, NOW)).toBe(true);
  });
});

describe('formatters', () => {
  it('formats relative times', () => {
    expect(formatAgo(null, NOW)).toBe('Never');
    expect(formatAgo(NOW - 2_000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 12_000, NOW)).toBe('12s ago');
    expect(formatAgo(NOW - 4 * 60_000, NOW)).toBe('4m ago');
    expect(formatAgo(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
  });

  it('formats uptime', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3h 5m');
  });
});
