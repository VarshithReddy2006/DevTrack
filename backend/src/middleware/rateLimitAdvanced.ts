// src/middleware/rateLimitAdvanced.ts — Advanced rate limiting with Redis backend
// Phase-1 Hardening: Rate limiting layer

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { getRedisClient, isRedisConfigured } from '../shared/redis/client.js';
import { logger } from '../shared/logger.js';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
  blockDurationMs: number;
  enableBurstHandling: boolean;
}

interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
  retryAfterMs?: number;
}

// Default configurations per endpoint type
const ENDPOINT_CONFIGS: Record<string, RateLimitConfig> = {
  sse: {
    windowMs: 60_000, // 1 minute
    maxRequests: 5, // Allow reconnects
    keyPrefix: 'rl:sse',
    blockDurationMs: 30_000,
    enableBurstHandling: true,
  },
  streak: {
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: 'rl:streak',
    blockDurationMs: 60_000,
    enableBurstHandling: true,
  },
  sync: {
    windowMs: 300_000, // 5 minutes
    maxRequests: 10,
    keyPrefix: 'rl:sync',
    blockDurationMs: 120_000,
    enableBurstHandling: false,
  },
  xp: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: 'rl:xp',
    blockDurationMs: 30_000,
    enableBurstHandling: true,
  },
  // AI/ML endpoints - stricter rate limiting to protect API costs
  ai: {
    windowMs: 60_000, // 1 minute
    maxRequests: 10, // 10 AI requests per minute per user
    keyPrefix: 'rl:ai',
    blockDurationMs: 300_000, // 5 minute block on abuse
    enableBurstHandling: false,
  },
  embedding: {
    windowMs: 60_000,
    maxRequests: 20, // 20 embedding requests per minute
    keyPrefix: 'rl:embedding',
    blockDurationMs: 180_000, // 3 minute block
    enableBurstHandling: false,
  },
  resume: {
    windowMs: 300_000, // 5 minutes
    maxRequests: 5, // 5 resume generations per 5 minutes
    keyPrefix: 'rl:resume',
    blockDurationMs: 600_000, // 10 minute block
    enableBurstHandling: false,
  },
  resumeRead: {
    windowMs: 60_000,
    maxRequests: 120, // 1.5s polling (40/min), with room for report reads and tabs
    keyPrefix: 'rl:resume-read',
    blockDurationMs: 30_000,
    enableBurstHandling: true,
  },
  resumeReadIngress: {
    windowMs: 60_000,
    maxRequests: 600, // Coarse IP protection before authentication; separate from user budgets
    keyPrefix: 'rl:resume-read-ingress',
    blockDurationMs: 30_000,
    enableBurstHandling: true,
  },
  interviewAudio: {
    windowMs: 60_000,
    maxRequests: 180, // frequent 1-2s audio slices during real-time speech
    keyPrefix: 'rl:interview-audio',
    blockDurationMs: 30_000,
    enableBurstHandling: true,
  },
  default: {
    windowMs: 60_000,
    maxRequests: 100,
    keyPrefix: 'rl:default',
    blockDurationMs: 30_000,
    enableBurstHandling: true,
  },
  analytics: {
    windowMs: 60_000, // 1 minute
    maxRequests: 30, // 30 analytics events per user/ip per min
    keyPrefix: 'rl:analytics',
    blockDurationMs: 60_000,
    enableBurstHandling: true,
  },
};

export function createRateLimiter(endpointType: string) {
  const config = ENDPOINT_CONFIGS[endpointType] || ENDPOINT_CONFIGS.default;

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (process.env.NODE_ENV === 'development' || !isRedisConfigured()) {
      next();
      return;
    }

    const redis = getRedisClient();
    if (
      !redis ||
      typeof redis.get !== 'function' ||
      typeof redis.incr !== 'function' ||
      typeof redis.ttl !== 'function'
    ) {
      next();
      return;
    }

    try {
      const identifier = getIdentifier(req);
      const now = Date.now();

      // Build rate limit key
      const key = `${config.keyPrefix}:${identifier}`;
      const blockKey = `${key}:blocked`;

      // Check if currently blocked
      const isBlocked = await redis.get(blockKey);
      if (isBlocked) {
        const ttl = await redis.ttl(blockKey);
        logger.warn('[rate-limit] Request blocked', {
          endpointType,
          identifier,
          blockTtlSeconds: ttl,
        });

        res.set('Retry-After', String(Math.ceil(ttl)));
        res.status(429).json({
          success: false,
          message: 'Too many requests. You have been temporarily blocked.',
          code: 'RATE_LIMIT_BLOCKED',
          retryAfter: Math.ceil(ttl),
        });
        return;
      }

      // Increment request count
      const currentCount = await redis.incr(key);

      // Set expiry on first request
      if (currentCount === 1) {
        if (typeof redis.pexpire === 'function') {
          await redis.pexpire(key, config.windowMs);
        } else if (typeof redis.expire === 'function') {
          await redis.expire(key, Math.ceil(config.windowMs / 1000));
        }
      }

      // Calculate reset time
      const ttl = await redis.ttl(key);
      const resetAt = now + (ttl >= 0 ? ttl * 1000 : config.windowMs);

      // Check if over limit
      if (currentCount > config.maxRequests) {
        // Block the user
        if (typeof redis.set === 'function') {
          await redis.set(blockKey, '1', 'PX', config.blockDurationMs);
        }

        logger.warn('[rate-limit] Rate limit exceeded, blocking', {
          endpointType,
          identifier,
          currentCount,
          maxRequests: config.maxRequests,
          windowMs: config.windowMs,
        });

        res.set('Retry-After', String(Math.ceil(config.blockDurationMs / 1000)));
        res.status(429).json({
          success: false,
          message: 'Rate limit exceeded',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil(config.blockDurationMs / 1000),
        });
        return;
      }

      // Add rate limit headers
      const remaining = Math.max(0, config.maxRequests - currentCount);
      res.set('X-RateLimit-Limit', String(config.maxRequests));
      res.set('X-RateLimit-Remaining', String(remaining));
      res.set('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

      // Log burst detection if enabled
      if (config.enableBurstHandling && currentCount > config.maxRequests * 0.8) {
        logger.info('[rate-limit] High request rate detected', {
          endpointType,
          identifier,
          currentCount,
          maxRequests: config.maxRequests,
          percentUsed: Math.round((currentCount / config.maxRequests) * 100),
        });
      }

      next();
    } catch (err) {
      logger.warn('[rate-limit] Redis error, bypassing rate limit', { error: err });
      next();
    }
  };
}

// Get identifier from request (IP + userId if authenticated)
function getIdentifier(req: Request): string {
  // Try to get user ID if authenticated
  const user = (req as unknown as { user?: { id?: string } }).user;
  const userId = user?.id;

  if (userId) {
    return `user:${userId}`;
  }

  // Fall back to IP address
  const ip = req.ip || (req.socket as unknown as { remoteAddress?: string })?.remoteAddress || 'unknown';
  return `ip:${ip}`;
}

// Atomic sliding-window limiter for expensive, user-triggered regeneration.
// Redis stores one timestamp per accepted request and expires the key after one window.
const EXPENSIVE_ACTION_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, math.max(1, tonumber(oldest[2]) + window - now)}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return {1, limit - count - 1}
`;

export function createSlidingWindowRateLimiter(windowMs: number, maxRequests: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = (req as Request & { user?: { id?: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }
    try {
      const result = await getRedisClient().eval(
        EXPENSIVE_ACTION_SCRIPT, 1, `rl:expensive-action:user:${userId}`,
        String(Date.now()), String(windowMs), String(maxRequests), randomUUID(),
      );
      if (!Array.isArray(result) || result.length !== 2) throw new Error('Invalid rate limit response');
      const [allowed, value] = result.map(Number);
      if ((allowed !== 0 && allowed !== 1) || !Number.isFinite(value) || value < 0) {
        throw new Error('Invalid rate limit response');
      }
      if (!allowed) {
        res.set('Retry-After', String(Math.ceil(value / 1000)));
        res.status(429).json({ success: false, message: 'Recommendation refresh limit exceeded', code: 'RATE_LIMIT_EXCEEDED' });
        return;
      }
      res.set('X-RateLimit-Limit', String(maxRequests));
      res.set('X-RateLimit-Remaining', String(value));
      next();
    } catch (error) {
      // Fail closed when Redis is unavailable: an unbounded LLM operation is unsafe.
      next(error);
    }
  };
}

// Pre-configured rate limiters for common endpoints
export const rateLimiters = {
  sse: createRateLimiter('sse'),
  streak: createRateLimiter('streak'),
  sync: createRateLimiter('sync'),
  xp: createRateLimiter('xp'),
  ai: createRateLimiter('ai'),
  embedding: createRateLimiter('embedding'),
  resume: createRateLimiter('resume'),
  resumeRead: createRateLimiter('resumeRead'),
  resumeReadIngress: createRateLimiter('resumeReadIngress'),
  interviewAudio: createRateLimiter('interviewAudio'),
  analytics: createRateLimiter('analytics'),
  expensiveAction: createSlidingWindowRateLimiter(3_600_000, 5),
  default: createRateLimiter('default'),
};

// Helper to check rate limit without middleware
export async function checkRateLimit(
  endpointType: string,
  identifier: string
): Promise<RateLimitResult> {
  if (!isRedisConfigured()) {
    return { success: true, remaining: 100, resetAt: Date.now() + 60_000 };
  }
  const config = ENDPOINT_CONFIGS[endpointType] || ENDPOINT_CONFIGS.default;
  const redis = getRedisClient();

  const key = `${config.keyPrefix}:${identifier}`;
  const blockKey = `${key}:blocked`;

  const isBlocked = await redis.get(blockKey);
  if (isBlocked) {
    const ttl = await redis.ttl(blockKey);
    return {
      success: false,
      remaining: 0,
      resetAt: Date.now() + ttl,
      retryAfterMs: ttl * 1000,
    };
  }

  const currentCount = parseInt((await redis.get(key)) || '0', 10);
  const ttl = await redis.ttl(key);

  return {
    success: currentCount < config.maxRequests,
    remaining: Math.max(0, config.maxRequests - currentCount),
    resetAt: Date.now() + (ttl > 0 ? ttl : config.windowMs),
  };
}
