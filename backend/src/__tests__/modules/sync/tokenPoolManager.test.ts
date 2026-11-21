import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TokenPoolManager,
  parseRateLimitHeaders,
  QuotaExhaustedError,
  hashToken,
} from '../../../modules/sync/tokenPoolManager.service.js';

describe('TokenPoolManager', () => {
  let manager: TokenPoolManager;
  let mockQueue: {
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TokenPoolManager();
    manager.reset();

    mockQueue = {
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
    };
    manager.setQueue(mockQueue as any);
  });

  afterEach(async () => {
    await manager.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('parseRateLimitHeaders', () => {
    it('extracts standard rate-limit headers correctly', () => {
      const headers = {
        'x-ratelimit-remaining': '4950',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '1732200000',
      };

      const result = parseRateLimitHeaders(headers);
      expect(result.remaining).toBe(4950);
      expect(result.limit).toBe(5000);
      expect(result.resetEpochMs).toBe(1732200000 * 1000);
    });

    it('extracts retry-after integer seconds and computes reset timestamp', () => {
      const now = 1000000;
      vi.setSystemTime(now);

      const headers = {
        'retry-after': '120',
      };

      const result = parseRateLimitHeaders(headers);
      expect(result.resetEpochMs).toBe(now + 120000);
    });

    it('handles Fetch Headers object instance and case-insensitivity', () => {
      const headers = new Headers();
      headers.set('X-RateLimit-Remaining', '1234');
      headers.set('X-RateLimit-Limit', '5000');
      headers.set('X-RateLimit-Reset', '1800000000');

      const result = parseRateLimitHeaders(headers);
      expect(result.remaining).toBe(1234);
      expect(result.limit).toBe(5000);
      expect(result.resetEpochMs).toBe(1800000000 * 1000);
    });

    it('returns empty object when headers are missing or undefined', () => {
      expect(parseRateLimitHeaders(undefined)).toEqual({});
    });
  });

  describe('Token Rotation & Quota-Weighted Leasing', () => {
    it('leases the token with the highest remaining quota', async () => {
      manager.registerTokens('github', ['token-high', 'token-medium', 'token-low']);

      // Simulate different quota states
      await manager.recordResponse('github', 'token-high', { 'x-ratelimit-remaining': '4500' }, 200);
      await manager.recordResponse('github', 'token-medium', { 'x-ratelimit-remaining': '2000' }, 200);
      await manager.recordResponse('github', 'token-low', { 'x-ratelimit-remaining': '500' }, 200);

      const lease1 = await manager.leaseToken('github');
      expect(lease1?.token).toBe('token-high');
      await lease1?.release();

      // Lower token-high below token-medium
      await manager.recordResponse('github', 'token-high', { 'x-ratelimit-remaining': '1000' }, 200);

      const lease2 = await manager.leaseToken('github');
      expect(lease2?.token).toBe('token-medium');
      await lease2?.release();
    });

    it('rotates across tokens with equal or similar quota', async () => {
      manager.registerTokens('github', ['token-a', 'token-b', 'token-c']);

      await manager.recordResponse('github', 'token-a', { 'x-ratelimit-remaining': '5000' }, 200);
      await manager.recordResponse('github', 'token-b', { 'x-ratelimit-remaining': '5000' }, 200);
      await manager.recordResponse('github', 'token-c', { 'x-ratelimit-remaining': '5000' }, 200);

      const tokensSeen: string[] = [];
      for (let i = 0; i < 3; i++) {
        const lease = await manager.leaseToken('github');
        tokensSeen.push(lease!.token);
        await lease?.release();
      }

      // Should have rotated across different tokens
      const uniqueTokens = new Set(tokensSeen);
      expect(uniqueTokens.size).toBeGreaterThan(1);
    });

    it('skips exhausted tokens and leases the remaining valid token', async () => {
      manager.registerTokens('github', ['token-exhausted', 'token-active']);

      // Exhaust token-exhausted
      await manager.recordResponse(
        'github',
        'token-exhausted',
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor((Date.now() + 60000) / 1000)) },
        429
      );

      const lease = await manager.leaseToken('github');
      expect(lease?.token).toBe('token-active');
      await lease?.release();
    });
  });

  describe('Queue Backpressure & Delayed Resumption', () => {
    it('pauses queue when all tokens are exhausted and schedules delayed resume', async () => {
      const now = Date.now();
      const resetTime = now + 45000;
      manager.registerTokens('github', ['token-1', 'token-2']);

      // Exhaust token 1
      await manager.recordResponse('github', 'token-1', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(resetTime / 1000)) }, 429);
      expect(mockQueue.pause).not.toHaveBeenCalled();

      // Exhaust token 2 (now all tokens are exhausted)
      await manager.recordResponse('github', 'token-2', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(resetTime / 1000)) }, 429);

      expect(mockQueue.pause).toHaveBeenCalledTimes(1);
      expect(manager.isQueuePaused('github')).toBe(true);

      // Attempting to lease throws QuotaExhaustedError
      await expect(manager.leaseToken('github')).rejects.toThrow(QuotaExhaustedError);

      // Advance clock past reset time
      vi.advanceTimersByTime(46000);

      // Queue should have resumed automatically
      expect(mockQueue.resume).toHaveBeenCalledTimes(1);
      expect(manager.isQueuePaused('github')).toBe(false);

      // Tokens should now be available again after reset
      const lease = await manager.leaseToken('github');
      expect(lease).not.toBeNull();
      await lease?.release();
    });

    it('correctly handles 429 HTTP status with default backoff when headers are missing', async () => {
      manager.registerTokens('github', ['token-solo']);

      // 429 without rate-limit headers
      await manager.recordResponse('github', 'token-solo', {}, 429);

      expect(mockQueue.pause).toHaveBeenCalled();
      const status = manager.getTokenStatuses('github')[0];
      expect(status.remaining).toBe(0);
      expect(status.resetEpochMs).toBeGreaterThan(Date.now());
    });
  });

  describe('Concurrency & Lease Release', () => {
    it('tracks inFlight count and decrements properly upon release', async () => {
      manager.registerTokens('github', ['token-conc']);

      const lease1 = await manager.leaseToken('github');
      const statusesDuring = manager.getTokenStatuses('github');
      expect(statusesDuring[0].inFlight).toBe(1);

      await lease1?.release();
      const statusesAfter = manager.getTokenStatuses('github');
      expect(statusesAfter[0].inFlight).toBe(0);

      // Re-releasing is safe and idempotent
      await lease1?.release();
      expect(manager.getTokenStatuses('github')[0].inFlight).toBe(0);
    });

    it('returns null if no tokens are configured for platform', async () => {
      const lease = await manager.leaseToken('unknown-platform');
      expect(lease).toBeNull();
    });

    it('produces safe masked token hashes', () => {
      const hash1 = hashToken('ghp_secret_token_123');
      const hash2 = hashToken('ghp_secret_token_123');
      const hash3 = hashToken('ghp_secret_token_456');

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1.length).toBe(12);
      expect(hash1).not.toContain('secret');
    });
  });
});
