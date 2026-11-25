// SSE handshake: ticket-only authentication and the connection limiter on GET /events.
// Runs the real route table, auth middleware, ticket store and sseHandler over HTTP.
// Redis, Clerk and the user lookup are in-memory fakes, so nothing touches a real service.
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  now: Date.parse('2026-11-16T00:00:00Z'),
  values: new Map<string, { value: string; expiresAt?: number }>(),
  registered: [] as string[],
}));

// Redis reports a non-ready status, so the ticket store uses its in-memory path.
// The rate limiter only needs get / incr / pexpire / ttl / set.
vi.mock('../../../shared/redis/client.js', () => ({
  isRedisConfigured: () => true,
  getRedisClient: () => ({
  status: 'end',
  async get(key: string) {
    const entry = fixture.values.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      fixture.values.delete(key);
      return null;
    }
    return entry?.value ?? null;
  },
  async incr(key: string) {
    const value = Number(await this.get(key)) + 1;
    fixture.values.set(key, { ...fixture.values.get(key), value: String(value) });
    return value;
  },
  async pexpire(key: string, ms: number) {
    fixture.values.get(key)!.expiresAt = Date.now() + ms;
  },
  async ttl(key: string) {
    await this.get(key);
    const entry = fixture.values.get(key);
    return !entry ? -2 : entry.expiresAt === undefined ? -1 : Math.ceil((entry.expiresAt - Date.now()) / 1000);
  },
  async set(key: string, value: string, _mode: string, ms: number) {
    fixture.values.set(key, { value, expiresAt: Date.now() + ms });
  },
}) }));
vi.mock('../../../shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
// Real auth middleware; only Clerk verification and the local user lookup are replaced.
vi.mock('@clerk/backend', () => ({ verifyToken: async (token: string) => {
  if (!['user-a', 'user-b'].includes(token)) throw new Error('Invalid test token');
  return { sub: token };
} }));
vi.mock('../../../db/models/index.js', () => ({ User: { findOne: async ({ clerkId }: { clerkId: string }) => ({
  _id: clerkId, clerkId, email: `${clerkId}@example.test`, username: clerkId, role: 'user',
}) } }));
vi.mock('../../../services/auth/ClerkUserSyncService.js', () => ({ syncClerkUser: vi.fn() }));
// Event bus stub: no heartbeat timers, and registrations are recorded per user.
vi.mock('../../../shared/sse/eventBus.js', () => ({
  eventBus: {
    startHeartbeat: vi.fn(),
    register: (client: { userId: string }) => { fixture.registered.push(client.userId); },
    unregister: vi.fn(),
  },
  EventBus: class {},
}));
vi.mock('../../../modules/dashboard/index.js', () => ({ dashboardRoutes: express.Router() }));
vi.mock('../../../modules/dsa/index.js', () => ({ dsaRoutes: express.Router() }));
vi.mock('../../../modules/activity/index.js', () => ({ activityRoutes: express.Router() }));
vi.mock('../../../modules/projects/index.js', () => ({ projectsRoutes: express.Router() }));
vi.mock('../../../modules/profile/index.js', () => ({ profileRoutes: express.Router() }));
vi.mock('../../../modules/settings/index.js', () => ({ settingsRoutes: express.Router() }));
vi.mock('../../../modules/platform-sync/index.js', () => ({ syncRoutes: express.Router() }));
vi.mock('../../../modules/xp/xp.routes.js', () => ({ xpRoutes: express.Router() }));
vi.mock('../../../modules/streak/index.js', () => ({ streakRoutes: express.Router() }));
vi.mock('../../../modules/ops/ops.routes.js', () => ({ opsRoutes: express.Router() }));
vi.mock('../../../modules/runtime-state/index.js', () => ({ runtimeStateRoutes: express.Router() }));
vi.mock('../../../modules/observation/index.js', () => ({ observationRoutes: express.Router() }));
vi.mock('../../../modules/missions/missions.routes.js', () => ({ default: express.Router() }));
vi.mock('../../../modules/notifications/notification.routes.js', () => ({ default: express.Router() }));
vi.mock('../../../modules/onboarding/onboarding.routes.js', () => ({ default: express.Router() }));
vi.mock('../../../modules/daily-challenge/index.js', () => ({ dailyChallengeRoutes: express.Router() }));
vi.mock('../../../modules/coaching/index.js', () => ({ coachingRoutes: express.Router() }));
vi.mock('../../../modules/readiness/index.js', () => ({ readinessRoutes: express.Router() }));
vi.mock('../../../modules/recommendations/recommendation.routes.js', () => ({ default: express.Router() }));
vi.mock('../../../modules/analytics/analytics.routes.js', () => ({ default: express.Router() }));
vi.mock('../../../modules/activity/focus.routes.js', () => ({ focusRoutes: express.Router() }));
vi.mock('../../../modules/platform-sync/contest.routes.js', () => ({ default: express.Router() }));
vi.mock('../../../modules/resume/upload/upload.routes.js', () => ({ default: express.Router() }));
vi.mock('../../../modules/resume/routes/evidence.routes.js', () => ({ evidenceRoutes: express.Router() }));
vi.mock('../../../modules/resume/index.js', () => ({ resumeIntelligenceRoutes: express.Router() }));
vi.mock('../../../modules/revision/index.js', () => ({ revisionRoutes: express.Router() }));
vi.mock('../../../modules/ai/quota.routes.js', () => ({ aiQuotaRoutes: express.Router() }));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1:1/unused_sse');
  vi.stubEnv('CORS_ORIGIN', 'https://example.test');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_fixture_unused');
  vi.stubEnv('RATE_LIMIT_WINDOW_MS', '900000');
  vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', '1000');
  const { default: routes } = await import('../../../routes/index.js');
  const { mountApiRoutes } = await import('../../../routes/mount.js');
  const app = express();
  app.use(express.json());
  mountApiRoutes(app, routes);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  fixture.values.clear();
  fixture.registered.length = 0;
  // Date-only clock: HTTP and runner timers stay real.
  fixture.now += 900_001;
  vi.spyOn(Date, 'now').mockImplementation(() => fixture.now);
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function issueTicket(user = 'user-a'): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/sse-handshake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { ticket: string } }).data.ticket;
}

/** Opens GET /events. A 200 is an endless stream, so it is aborted once headers arrive. */
async function connect(query: string) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/v1/events${query}`, { signal: controller.signal });
  const body = res.status === 200 ? null : await res.json() as { error: string; code?: string };
  const retryAfter = res.headers.get('Retry-After');
  controller.abort();
  return { status: res.status, body, retryAfter };
}

describe('GET /events ticket-only handshake', () => {
  it('opens the stream for a valid ticket and registers the ticket owner', async () => {
    const ticket = await issueTicket('user-a');
    const res = await connect(`?ticket=${ticket}`);
    expect(res.status).toBe(200);
    expect(fixture.registered).toEqual(['user-a']);
  });

  it('rejects a raw JWT in ?token= with 401 and never registers a client', async () => {
    const res = await connect('?token=user-a');
    expect(res.status).toBe(401);
    expect(res.body?.code).toBe('INVALID_OR_MISSING_TICKET');
    expect(fixture.registered).toEqual([]);
  });

  it('still rejects ?token= when it is sent next to an invalid ticket', async () => {
    const res = await connect('?token=user-a&ticket=00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
    expect(fixture.registered).toEqual([]);
  });

  it('rejects a request with no ticket', async () => {
    const res = await connect('');
    expect(res.status).toBe(401);
    expect(res.body?.code).toBe('INVALID_OR_MISSING_TICKET');
  });

  it('rejects a repeated ?ticket= parameter instead of picking one', async () => {
    const ticket = await issueTicket();
    const res = await connect(`?ticket=${ticket}&ticket=${ticket}`);
    expect(res.status).toBe(401);
    expect(fixture.registered).toEqual([]);
  });

  it('rejects an unknown ticket', async () => {
    const res = await connect('?ticket=00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
    expect(res.body?.code).toBe('INVALID_OR_MISSING_TICKET');
  });

  it('consumes the ticket: a replay gets 401', async () => {
    const ticket = await issueTicket();
    expect((await connect(`?ticket=${ticket}`)).status).toBe(200);
    const replay = await connect(`?ticket=${ticket}`);
    expect(replay.status).toBe(401);
    expect(fixture.registered).toEqual(['user-a']);
  });

  it('rejects a ticket after its 10 second lifetime', async () => {
    const ticket = await issueTicket();
    fixture.now += 10_001;
    const res = await connect(`?ticket=${ticket}`);
    expect(res.status).toBe(401);
    expect(fixture.registered).toEqual([]);
  });

  it('never writes the ticket or the token to the logs', async () => {
    const { logger } = await import('../../../shared/logger.js');
    const ticket = await issueTicket();
    await connect(`?ticket=${ticket}`);
    await connect(`?ticket=${ticket}`);
    await connect('?token=secret-jwt-value');
    const logged = JSON.stringify([
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ]);
    expect(logged).not.toContain(ticket);
    expect(logged).not.toContain('secret-jwt-value');
  });
});

describe('GET /events connection limiter', () => {
  it('serves five connection attempts per minute, then answers 429 before touching the ticket', async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await connect(`?ticket=${await issueTicket()}`)).status, `attempt ${attempt}`).toBe(200);
    }
    // A perfectly valid ticket is not even consumed once the limiter trips.
    const ticket = await issueTicket();
    const blocked = await connect(`?ticket=${ticket}`);
    expect(blocked.status).toBe(429);
    expect(blocked.body?.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
    expect(fixture.registered).toHaveLength(5);
  });

  it('counts failed handshakes too, so bad tickets cannot be guessed without bound', async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await connect('?token=user-a')).status).toBe(401);
    }
    expect((await connect('?token=user-a')).status).toBe(429);
  });

  it('lets the client back in after the block expires', async () => {
    for (let attempt = 1; attempt <= 6; attempt++) await connect('');
    expect((await connect('')).status).toBe(429);
    fixture.now += 61_000;
    expect((await connect('')).status).toBe(401);
  });
});
