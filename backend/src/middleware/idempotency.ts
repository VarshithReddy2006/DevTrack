// src/middleware/idempotency.ts — HTTP Idempotency-Key request replay middleware
// Implements RFC 9440-compatible request deduplication and replay with Redis atomic locks.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getRedisClient, isRedisConfigured } from '../shared/redis/client.js';
import { logger } from '../shared/logger.js';

export interface IdempotencyOptions {
  /**
   * If true, requests without an Idempotency-Key header are rejected with 400 Bad Request.
   * Default: false (requests without the header pass through).
   */
  required?: boolean;

  /**
   * Time-to-live in seconds for completed responses stored in Redis cache.
   * Default: 86400 (24 hours).
   */
  ttlSec?: number;

  /**
   * Lock timeout in seconds for in-progress request execution before automatic expiration.
   * Default: 30 seconds.
   */
  lockTimeoutSec?: number;

  /**
   * Custom key prefix for Redis keys.
   * Default: 'idempotency'
   */
  keyPrefix?: string;
}

export interface StoredIdempotencyPayload {
  status: 'processing' | 'completed';
  statusCode: number;
  body: string;
  headers: Record<string, string | undefined>;
}

export function createIdempotencyMiddleware(options: IdempotencyOptions = {}): RequestHandler {
  const {
    required = false,
    ttlSec = 86400,
    lockTimeoutSec = 30,
    keyPrefix = 'idempotency',
  } = options;

  return async function idempotencyHandler(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const rawHeader = req.header('idempotency-key') || req.header('Idempotency-Key');
    const idempotencyKey = (rawHeader || '').trim();

    if (!idempotencyKey) {
      if (required) {
        res.status(400).json({
          success: false,
          message: 'Idempotency-Key header is required for this endpoint',
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          timestamp: new Date().toISOString(),
        });
        return;
      }
      return next();
    }

    if (!isRedisConfigured()) {
      logger.warn('[idempotency] Redis is not configured; skipping idempotency enforcement');
      return next();
    }

    const redis = getRedisClient();
    const userId = (req as any).user?.id || (req as any).user?._id?.toString() || (req as any).user?.clerkId || 'anonymous';
    const method = req.method.toUpperCase();
    const path = req.baseUrl ? `${req.baseUrl}${req.path}` : (req.originalUrl?.split('?')[0] || req.path);
    const redisKey = `${keyPrefix}:${userId}:${method}:${path}:${idempotencyKey}`;

    try {
      // 1. Attempt atomic lock acquisition with in-progress marker
      const lockAcquired = await redis.set(
        redisKey,
        JSON.stringify({ status: 'processing' }),
        'EX',
        lockTimeoutSec,
        'NX'
      );

      if (!lockAcquired) {
        // Key exists: inspect current state
        const rawExisting = await redis.get(redisKey);
        if (rawExisting) {
          let existingRecord: any = null;
          try {
            existingRecord = JSON.parse(rawExisting);
          } catch {
            if (rawExisting === 'processing') {
              existingRecord = { status: 'processing' };
            }
          }

          if (existingRecord?.status === 'processing') {
            res.status(409).json({
              success: false,
              message: 'A request with this Idempotency-Key is currently in progress',
              code: 'IDEMPOTENCY_IN_PROGRESS',
              timestamp: new Date().toISOString(),
            });
            return;
          }

          if (existingRecord?.status === 'completed') {
            // Replay the cached response
            res.set('Idempotent-Replayed', 'true');
            if (existingRecord.headers && typeof existingRecord.headers === 'object') {
              for (const [headerName, headerVal] of Object.entries(existingRecord.headers)) {
                if (headerVal && headerName.toLowerCase() !== 'idempotent-replayed') {
                  res.set(headerName, headerVal as string);
                }
              }
            }
            res.status(existingRecord.statusCode || 200);
            if (existingRecord.body !== undefined && existingRecord.body !== null) {
              res.send(existingRecord.body);
            } else {
              res.end();
            }
            return;
          }
        }
      }

      // Lock acquired — intercept response completion
      let finalized = false;
      const originalSend = res.send.bind(res);

      const finalize = async (body?: any) => {
        if (finalized) return;
        finalized = true;

        try {
          if (res.statusCode >= 500) {
            // Release lock on server errors so client can retry
            await redis.del(redisKey);
          } else {
            const headersToSave: Record<string, string | undefined> = {};
            const contentType = res.get('content-type');
            if (contentType) {
              headersToSave['content-type'] = contentType;
            }

            let serializedBody = '';
            if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
              serializedBody = JSON.stringify(body);
            } else if (Buffer.isBuffer(body)) {
              serializedBody = body.toString('utf-8');
            } else {
              serializedBody = String(body ?? '');
            }

            const payload: StoredIdempotencyPayload = {
              status: 'completed',
              statusCode: res.statusCode,
              body: serializedBody,
              headers: headersToSave,
            };

            await redis.set(redisKey, JSON.stringify(payload), 'EX', ttlSec);
          }
        } catch (storageErr) {
          logger.error('[idempotency] Error updating idempotency record in Redis', {
            error: (storageErr as Error).message,
            redisKey,
          });
        }
      };

      res.send = (async function (body?: any): Promise<Response> {
        await finalize(body);
        return originalSend(body);
      }) as unknown as typeof res.send;

      res.on('close', () => {
        if (!finalized && !res.writableEnded) {
          redis.del(redisKey).catch(() => {});
        }
      });

      return next();
    } catch (err) {
      logger.error('[idempotency] Redis error during lock/check execution', { error: (err as Error).message });
      return next();
    }
  };
}

export function idempotency(
  optionsOrReq?: IdempotencyOptions | Request,
  res?: Response,
  next?: NextFunction
): any {
  if (res && next && optionsOrReq && 'headers' in (optionsOrReq as Request)) {
    return createIdempotencyMiddleware({})(optionsOrReq as Request, res, next);
  }
  return createIdempotencyMiddleware((optionsOrReq as IdempotencyOptions) || {});
}

export const idempotencyMiddleware = idempotency;
