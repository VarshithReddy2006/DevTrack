import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import axiosClient from '../utils/axiosClient';
import {
  DEFAULT_RETRY_SECONDS,
  MAX_BACKOFF_SECONDS,
  MAX_RETRY_SECONDS,
  MIN_RETRY_SECONDS,
  clampRetrySeconds,
  parseRetryAfter,
  useMaintenanceStore,
} from './maintenanceStore';

afterEach(() => useMaintenanceStore.getState().exit());

function failingWith(status: number, headers: Record<string, string>): AxiosAdapter {
  return async (config: InternalAxiosRequestConfig) => {
    throw new AxiosError('failed', String(status), config, null, {
      status, statusText: '', headers, config, data: { message: 'Service unavailable' },
    });
  };
}

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');

  it('reads delay-seconds and HTTP dates', () => {
    expect(parseRetryAfter('60', now)).toBe(60);
    expect(parseRetryAfter(' 120 ', now)).toBe(120);
    expect(parseRetryAfter(30, now)).toBe(30);
    expect(parseRetryAfter('Fri, 20 Nov 2026 10:01:30 GMT', now)).toBe(90);
    expect(parseRetryAfter('Fri, 20 Nov 2026 09:00:00 GMT', now)).toBe(0);
  });

  it('rejects values it cannot use', () => {
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(-5, now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
  });

  it('keeps waits within sane bounds', () => {
    expect(clampRetrySeconds(0)).toBe(MIN_RETRY_SECONDS);
    expect(clampRetrySeconds(86_400)).toBe(MAX_RETRY_SECONDS);
  });
});

describe('maintenance state', () => {
  it('does not restart the countdown when more 503s arrive', () => {
    const { enter } = useMaintenanceStore.getState();
    enter(60, 1_000);
    enter(600, 5_000);
    expect(useMaintenanceStore.getState()).toMatchObject({ active: true, delaySeconds: 60, retryAt: 61_000 });
  });

  it('doubles the wait after each failed check, up to the cap', () => {
    const { enter, scheduleRetry } = useMaintenanceStore.getState();
    enter(100, 0);
    scheduleRetry(0);
    expect(useMaintenanceStore.getState()).toMatchObject({ delaySeconds: 200, retryAt: 200_000, failedChecks: 1 });
    scheduleRetry(0);
    expect(useMaintenanceStore.getState().delaySeconds).toBe(MAX_BACKOFF_SECONDS);
  });

  it('keeps a long server-requested wait instead of shrinking it', () => {
    const { enter, scheduleRetry } = useMaintenanceStore.getState();
    enter(900, 0);
    scheduleRetry(0);
    expect(useMaintenanceStore.getState().delaySeconds).toBe(900);
  });
});

describe('API client', () => {
  it('enters maintenance on a 503 with Retry-After and still rejects the request', async () => {
    await expect(axiosClient.get('/dashboard', { adapter: failingWith(503, { 'retry-after': '120' }) }))
      .rejects.toMatchObject({ statusCode: 503, retryAfter: '120' });
    expect(useMaintenanceStore.getState()).toMatchObject({ active: true, delaySeconds: 120 });
  });

  it('falls back to the default wait when Retry-After is unreadable', async () => {
    await expect(axiosClient.get('/dashboard', { adapter: failingWith(503, { 'retry-after': 'later' }) })).rejects.toBeTruthy();
    expect(useMaintenanceStore.getState().delaySeconds).toBe(DEFAULT_RETRY_SECONDS);
  });

  it('ignores 503s without Retry-After and other statuses', async () => {
    await expect(axiosClient.post('/notifications/subscribe', {}, { adapter: failingWith(503, {}) })).rejects.toBeTruthy();
    await expect(axiosClient.get('/dashboard', { adapter: failingWith(429, { 'retry-after': '30' }) })).rejects.toBeTruthy();
    expect(useMaintenanceStore.getState().active).toBe(false);
  });
});
