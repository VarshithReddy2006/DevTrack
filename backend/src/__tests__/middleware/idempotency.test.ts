import express, { type Request, type Response, type NextFunction } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { idempotency, createIdempotencyMiddleware } from '../../middleware/idempotency.js';

interface RedisStoreEntry {
  value: string;
  expiresAt?: number;
}

const memoryStore = new Map<string, RedisStoreEntry>();
let redisConfigured = true;

vi.mock('../../shared/redis/client.js', () => ({
  isRedisConfigured: () => redisConfigured,
  getRedisClient: () => ({
    async get(key: string) {
      const entry = memoryStore.get(key);
      if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        memoryStore.delete(key);
        return null;
      }
      return entry?.value ?? null;
    },
    async set(key: string, value: string, ...args: any[]) {
      let isNx = false;
      let ttlMs: number | undefined;

      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg === 'string' && arg.toUpperCase() === 'NX') {
          isNx = true;
        } else if (typeof arg === 'string' && arg.toUpperCase() === 'EX') {
          ttlMs = Number(args[i + 1]) * 1000;
          i++;
        } else if (typeof arg === 'string' && arg.toUpperCase() === 'PX') {
          ttlMs = Number(args[i + 1]);
          i++;
        }
      }

      if (isNx) {
        const existing = memoryStore.get(key);
        if (existing && (existing.expiresAt === undefined || existing.expiresAt > Date.now())) {
          return null; // Key already exists, NX condition fails
        }
      }

      memoryStore.set(key, {
        value,
        expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
      });
      return 'OK';
    },
    async del(...keys: string[]) {
      let count = 0;
      for (const k of keys) {
        if (memoryStore.delete(k)) count++;
      }
      return count;
    },
  }),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Idempotency-Key Middleware', () => {
  beforeEach(() => {
    memoryStore.clear();
    redisConfigured = true;
    vi.clearAllMocks();
  });

  it('passes through when Idempotency-Key header is absent and not required', async () => {
    const middleware = createIdempotencyMiddleware({ required: false });
    const req = {
      header: vi.fn().mockReturnValue(undefined),
      headers: {},
      method: 'POST',
      path: '/api/v1/test',
    } as unknown as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      send: vi.fn(),
    } as unknown as Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(memoryStore.size).toBe(0);
  });

  it('returns 400 Bad Request when Idempotency-Key header is absent and required: true', async () => {
    const middleware = createIdempotencyMiddleware({ required: true });
    const req = {
      header: vi.fn().mockReturnValue(undefined),
      headers: {},
      method: 'POST',
      path: '/api/v1/test',
    } as unknown as Request;

    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const res = { status, json } as unknown as Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      })
    );
  });

  it('executes controller on first request and caches response payload in Redis', async () => {
    const app = express();
    app.use(express.json());

    let controllerRuns = 0;
    app.post(
      '/api/v1/focus/sessions/complete',
      idempotency({ ttlSec: 60 }),
      (req, res) => {
        controllerRuns++;
        res.status(200).json({ success: true, xpEarned: 50 });
      }
    );

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/focus/sessions/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'key-session-123',
        },
        body: JSON.stringify({ sessionId: 's-1' }),
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get('idempotent-replayed')).toBeNull();
      expect(body).toEqual({ success: true, xpEarned: 50 });
      expect(controllerRuns).toBe(1);

      // Verify stored in Redis
      const cached = await (await import('../../shared/redis/client.js')).getRedisClient().get(
        'idempotency:anonymous:POST:/api/v1/focus/sessions/complete:key-session-123'
      );
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(cached!);
      expect(parsed.status).toBe('completed');
      expect(parsed.statusCode).toBe(200);
      expect(JSON.parse(parsed.body)).toEqual({ success: true, xpEarned: 50 });
    } finally {
      server.close();
    }
  });

  it('replays cached response with Idempotent-Replayed: true header without invoking controller', async () => {
    const app = express();
    app.use(express.json());

    let controllerRuns = 0;
    app.post(
      '/api/v1/revision/reviews',
      idempotency({ ttlSec: 120 }),
      (req, res) => {
        controllerRuns++;
        res.status(201).json({ success: true, reviewId: `rev-${controllerRuns}` });
      }
    );

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      // First Request
      const firstRes = await fetch(`http://127.0.0.1:${port}/api/v1/revision/reviews`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-rev-unique-1',
        },
        body: JSON.stringify({ rating: 4 }),
      });

      const firstBody = await firstRes.json();
      expect(firstRes.status).toBe(201);
      expect(firstRes.headers.get('idempotent-replayed')).toBeNull();
      expect(firstBody).toEqual({ success: true, reviewId: 'rev-1' });
      expect(controllerRuns).toBe(1);

      // Second Request with SAME Idempotency-Key
      const secondRes = await fetch(`http://127.0.0.1:${port}/api/v1/revision/reviews`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-rev-unique-1',
        },
        body: JSON.stringify({ rating: 4 }),
      });

      const secondBody = await secondRes.json();
      expect(secondRes.status).toBe(201);
      expect(secondRes.headers.get('idempotent-replayed')).toBe('true');
      expect(secondBody).toEqual({ success: true, reviewId: 'rev-1' }); // Same exact body
      expect(controllerRuns).toBe(1); // Controller was NOT re-invoked
    } finally {
      server.close();
    }
  });

  it('returns 409 Conflict IDEMPOTENCY_IN_PROGRESS on concurrent duplicate requests', async () => {
    const app = express();
    app.use(express.json());

    let releaseController!: () => void;
    const controllerWaitingPromise = new Promise<void>((resolve) => {
      releaseController = resolve;
    });

    let controllerRuns = 0;
    app.post(
      '/api/v1/slow-job',
      idempotency(),
      async (req, res) => {
        controllerRuns++;
        await controllerWaitingPromise;
        res.status(200).json({ completed: true });
      }
    );

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      // Request 1 starts and waits
      const req1Promise = fetch(`http://127.0.0.1:${port}/api/v1/slow-job`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'concurrent-key-999',
        },
      });

      // Give event loop a cycle so Request 1 locks the key
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Request 2 arrives concurrently while Request 1 is still processing
      const req2Response = await fetch(`http://127.0.0.1:${port}/api/v1/slow-job`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'concurrent-key-999',
        },
      });

      expect(req2Response.status).toBe(409);
      const req2Body = await req2Response.json();
      expect(req2Body).toEqual(
        expect.objectContaining({
          success: false,
          code: 'IDEMPOTENCY_IN_PROGRESS',
        })
      );

      // Now release Request 1
      releaseController();
      const req1Response = await req1Promise;
      expect(req1Response.status).toBe(200);
      expect(controllerRuns).toBe(1);
    } finally {
      server.close();
    }
  });

  it('cleans up in-progress lock when controller throws an unhandled error (500)', async () => {
    const app = express();
    app.use(express.json());

    let throwError = true;
    let controllerRuns = 0;

    app.post(
      '/api/v1/flaky',
      idempotency(),
      (req, res, next) => {
        controllerRuns++;
        if (throwError) {
          return next(new Error('Database temporary connection failure'));
        }
        res.status(200).json({ ok: true, run: controllerRuns });
      }
    );

    // Error handler
    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      res.status(500).json({ success: false, message: err.message, code: 'INTERNAL_ERROR' });
    });

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      // First attempt fails with 500
      const firstRes = await fetch(`http://127.0.0.1:${port}/api/v1/flaky`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': 'retryable-key-fail',
        },
      });

      expect(firstRes.status).toBe(500);
      expect(controllerRuns).toBe(1);

      // Lock should have been released from Redis
      const redis = (await import('../../shared/redis/client.js')).getRedisClient();
      const keyInRedis = await redis.get('idempotency:anonymous:POST:/api/v1/flaky:retryable-key-fail');
      expect(keyInRedis).toBeNull();

      // Subsequent attempt with SAME key can succeed now without getting 409
      throwError = false;
      const retryRes = await fetch(`http://127.0.0.1:${port}/api/v1/flaky`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': 'retryable-key-fail',
        },
      });

      expect(retryRes.status).toBe(200);
      const retryBody = await retryRes.json();
      expect(retryBody).toEqual({ ok: true, run: 2 });
    } finally {
      server.close();
    }
  });

  it('partitions idempotency keys by authenticated user identity', async () => {
    const app = express();
    app.use(express.json());

    // Middleware injecting user from mock token header
    app.use((req, res, next) => {
      const userHeader = req.header('X-User-Id');
      if (userHeader) {
        (req as any).user = { id: userHeader };
      }
      next();
    });

    let controllerRuns = 0;
    app.post(
      '/api/v1/user-scoped',
      idempotency(),
      (req, res) => {
        controllerRuns++;
        res.status(200).json({ user: (req as any).user?.id, run: controllerRuns });
      }
    );

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      // User A makes a request with key "idem-common"
      const resA = await fetch(`http://127.0.0.1:${port}/api/v1/user-scoped`, {
        method: 'POST',
        headers: {
          'X-User-Id': 'user_a',
          'Idempotency-Key': 'idem-common',
        },
      });
      const bodyA = await resA.json();
      expect(bodyA).toEqual({ user: 'user_a', run: 1 });

      // User B makes a request with the SAME key "idem-common" — must NOT collide with user A
      const resB = await fetch(`http://127.0.0.1:${port}/api/v1/user-scoped`, {
        method: 'POST',
        headers: {
          'X-User-Id': 'user_b',
          'Idempotency-Key': 'idem-common',
        },
      });
      const bodyB = await resB.json();
      expect(bodyB).toEqual({ user: 'user_b', run: 2 });
      expect(resB.headers.get('idempotent-replayed')).toBeNull();

      // User A repeats request — replayed from cache
      const resA2 = await fetch(`http://127.0.0.1:${port}/api/v1/user-scoped`, {
        method: 'POST',
        headers: {
          'X-User-Id': 'user_a',
          'Idempotency-Key': 'idem-common',
        },
      });
      expect(resA2.headers.get('idempotent-replayed')).toBe('true');
      const bodyA2 = await resA2.json();
      expect(bodyA2).toEqual({ user: 'user_a', run: 1 });
    } finally {
      server.close();
    }
  });

  it('gracefully passes through when Redis is not configured', async () => {
    redisConfigured = false;

    const middleware = createIdempotencyMiddleware({ required: false });
    const req = {
      header: vi.fn().mockReturnValue('key-no-redis'),
      headers: { 'idempotency-key': 'key-no-redis' },
      method: 'POST',
      path: '/api/v1/test',
    } as unknown as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      send: vi.fn(),
    } as unknown as Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('exposes Idempotent-Replayed in CORS exposedHeaders and accepts Idempotency-Key in allowedHeaders', async () => {
    const cors = (await import('cors')).default;
    const app = express();
    app.use(cors({
      origin: 'http://localhost:3000',
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      exposedHeaders: ['Content-Length', 'X-Request-ID', 'Retry-After', 'Idempotent-Replayed'],
    }));

    app.post('/api/v1/test-cors', idempotency(), (req, res) => {
      res.status(200).json({ ok: true });
    });

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      // Preflight OPTIONS check
      const preflight = await fetch(`http://127.0.0.1:${port}/api/v1/test-cors`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Idempotency-Key',
        },
      });

      expect(preflight.status).toBe(204);
      const allowed = preflight.headers.get('access-control-allow-headers');
      expect(allowed?.toLowerCase()).toContain('idempotency-key');

      // Actual POST check
      const postRes = await fetch(`http://127.0.0.1:${port}/api/v1/test-cors`, {
        method: 'POST',
        headers: {
          'Origin': 'http://localhost:3000',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'cors-key-1',
        },
      });

      const exposed = postRes.headers.get('access-control-expose-headers');
      expect(exposed?.toLowerCase()).toContain('idempotent-replayed');
    } finally {
      server.close();
    }
  });
});
