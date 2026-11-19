// src/modules/profile/dossierToken.service.ts — Secure HMAC-signed download tokens for candidate dossiers.
// Tokens expire after 15 minutes and cryptographically bind the candidate username, expiration timestamp, and nonce.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getRedisClient, isRedisConfigured } from '../../shared/redis/client.js';

export const DOSSIER_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const DOSSIER_IP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const DOSSIER_IP_RATE_LIMIT_MAX_REQUESTS = 5; // 5 per hour per IP

export interface GeneratedDossierToken {
  token: string;
  expires: number;
  expiresAt: Date;
  nonce: string;
  signature: string;
  downloadUrl: string;
}

export interface VerifyDossierTokenParams {
  token: string;
  expires: string | number;
  nonce?: string;
}

export function getDossierSigningSecret(): string {
  const secret = process.env.DOSSIER_SIGNING_SECRET
    || process.env.OBJECT_STORAGE_SIGNING_SECRET
    || (process.env.NODE_ENV === 'production' ? undefined : 'devtrack-local-dev-signing-secret');
  if (!secret) {
    throw new Error('DOSSIER_SIGNING_SECRET or OBJECT_STORAGE_SIGNING_SECRET is required in production');
  }
  return secret;
}

export function computeDossierSignature(
  username: string,
  expires: string | number,
  nonce: string,
  secret = getDossierSigningSecret()
): string {
  const message = `${username}:${expires}:${nonce}`;
  return createHmac('sha256', secret).update(message).digest('base64url');
}

export function generateDossierToken(
  username: string,
  options: { now?: number; ttlMs?: number; secret?: string } = {}
): GeneratedDossierToken {
  if (!username || typeof username !== 'string') {
    throw new Error('Valid username is required to generate a dossier token');
  }
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DOSSIER_TOKEN_TTL_MS;
  const expires = now + ttlMs;
  const nonce = randomBytes(16).toString('hex');
  const secret = options.secret ?? getDossierSigningSecret();
  const signature = computeDossierSignature(username, expires, nonce, secret);
  // Self-contained token format: `${nonce}.${signature}`
  const token = `${nonce}.${signature}`;
  const downloadUrl = `/api/v2/portfolio/${encodeURIComponent(username)}/dossier.pdf?token=${encodeURIComponent(token)}&expires=${expires}`;

  return {
    token,
    expires,
    expiresAt: new Date(expires),
    nonce,
    signature,
    downloadUrl,
  };
}

export function verifyDossierToken(
  username: string,
  params: VerifyDossierTokenParams,
  options: { now?: number; secret?: string } = {}
): boolean {
  const { token, expires, nonce } = params;
  if (!username || typeof username !== 'string') return false;
  if (!token || typeof token !== 'string') return false;
  if (!expires || (typeof expires !== 'string' && typeof expires !== 'number')) return false;

  const expiresNum = typeof expires === 'number' ? expires : Number(expires);
  if (!Number.isFinite(expiresNum) || !/^\d{1,16}$/.test(String(expires))) return false;

  let extractedNonce = nonce || '';
  let extractedSignature = token;

  if (token.includes('.')) {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    extractedNonce = parts[0];
    extractedSignature = parts[1];
  }

  if (!extractedNonce || !extractedSignature) return false;

  try {
    const secret = options.secret ?? getDossierSigningSecret();
    const expected = computeDossierSignature(username, expiresNum, extractedNonce, secret);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(extractedSignature, 'utf8');

    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return false;
    }
  } catch {
    return false;
  }

  const now = options.now ?? Date.now();
  return expiresNum > now;
}

// In-memory sliding window fallback for unit tests and non-Redis environments
const inMemoryHits = new Map<string, number[]>();

export function resetDossierRateLimitStore(): void {
  inMemoryHits.clear();
}

export function checkIpSlidingWindowRateLimit(
  ip: string,
  now = Date.now(),
  windowMs = DOSSIER_IP_RATE_LIMIT_WINDOW_MS,
  maxRequests = DOSSIER_IP_RATE_LIMIT_MAX_REQUESTS
): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const timestamps = (inMemoryHits.get(ip) || []).filter(t => t > now - windowMs);
  if (timestamps.length >= maxRequests) {
    const oldest = timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }
  timestamps.push(now);
  inMemoryHits.set(ip, timestamps);
  return { allowed: true, remaining: maxRequests - timestamps.length, retryAfterSec: 0 };
}

const DOSSIER_SLIDING_WINDOW_SCRIPT = `
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

export const dossierRateLimiterDeps = {
  now: () => Date.now(),
  reset: resetDossierRateLimitStore,
};

export async function dossierRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = dossierRateLimiterDeps.now();

  if (isRedisConfigured()) {
    try {
      const redis = getRedisClient();
      const result = await redis.eval(
        DOSSIER_SLIDING_WINDOW_SCRIPT,
        1,
        `rl:dossier:ip:${ip}`,
        String(now),
        String(DOSSIER_IP_RATE_LIMIT_WINDOW_MS),
        String(DOSSIER_IP_RATE_LIMIT_MAX_REQUESTS),
        randomUUID()
      );

      if (Array.isArray(result) && result.length === 2) {
        const numbers = result.map(Number);
        const allowed = numbers[0];
        const value = numbers[1];
        if (allowed === 0) {
          const retryAfterSec = Math.max(1, Math.ceil(value / 1000));
          res.set('Retry-After', String(retryAfterSec));
          res.status(429).json({
            success: false,
            message: 'Maximum 5 PDF generation requests per hour exceeded. Please try again later.',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: retryAfterSec,
          });
          return;
        }
        res.set('X-RateLimit-Limit', String(DOSSIER_IP_RATE_LIMIT_MAX_REQUESTS));
        res.set('X-RateLimit-Remaining', String(value));
        next();
        return;
      }
    } catch {
      // Fallback to in-memory sliding window if Redis call fails
    }
  }

  const result = checkIpSlidingWindowRateLimit(ip, now);
  if (!result.allowed) {
    res.set('Retry-After', String(result.retryAfterSec));
    res.status(429).json({
      success: false,
      message: 'Maximum 5 PDF generation requests per hour exceeded. Please try again later.',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: result.retryAfterSec,
    });
    return;
  }

  res.set('X-RateLimit-Limit', String(DOSSIER_IP_RATE_LIMIT_MAX_REQUESTS));
  res.set('X-RateLimit-Remaining', String(result.remaining));
  next();
}
