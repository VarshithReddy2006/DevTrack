import express, { type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  now: Date.parse('2026-10-22T00:00:00Z'),
  values: new Map<string, { value: string; expiresAt?: number }>(),
  completed: false,
}));

// Expiring Redis fixture: no sockets, credentials, or cleanup against a real service.
vi.mock('../../shared/redis/client.js', () => ({ getRedisClient: () => ({
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
vi.mock('../../shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
// Keep real authentication; replace only Clerk verification and local user lookup.
vi.mock('@clerk/backend', () => ({ verifyToken: async (token: string) => {
  if (!['user-a', 'user-b'].includes(token)) throw new Error('Invalid test token');
  return { sub: token };
} }));
vi.mock('../../db/models/index.js', () => ({ User: { findOne: async ({ clerkId }: { clerkId: string }) => ({
  _id: clerkId, clerkId, email: `${clerkId}@example.test`, username: clerkId, role: 'user',
}) } }));
vi.mock('../../services/auth/ClerkUserSyncService.js', () => ({ syncClerkUser: vi.fn() }));
// Stub business work, keeping the real routes, validation and middleware order.
vi.mock('../../modules/resume/upload/multer.config.js', () => ({ uploadSingle: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../../modules/resume/upload/upload.validation.js', () => ({ validateUpload: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../../modules/resume/upload/upload.controller.js', () => ({
  resumeSession: (_req: unknown, res: Response) => res.json({ success: true }),
  uploadResume: (_req: unknown, res: Response) => res.json({ success: true }),
  getSession: (_req: unknown, res: Response) => res.json({ success: true }),
  getSessionStatus: (_req: unknown, res: Response) => res.json({ success: true, data: {
    sessionId: 'test-session', currentStage: fixture.completed ? 'COMPLETED' : 'PARSING',
  } }),
}));
vi.mock('../../modules/resume/controllers/ResumeIntelligenceController.js', () => {
  const respond = (_req: unknown, res: Response) => res.json({ success: true });
  return Object.fromEntries(['getProfile', 'updateProfile', 'generateResume', 'generateVariant', 'getVariants',
    'getVariant', 'analyzeATS', 'getATSAnalyses', 'createEvidenceClaim', 'getEvidenceClaims', 'exportResume', 'exportDossier',
    'getExportHistory', 'getVersionHistory', 'getCredibilityAnalysis', 'generateReport', 'getReport',
    'getProjects', 'getSkills'].map(name => [name, respond]));
});
vi.mock('../../modules/resume/index.js', async () => ({
  resumeIntelligenceRoutes: (await import('../../modules/resume/routes/resume-intelligence.routes.js')).default,
}));
vi.mock('../../modules/auth/index.js', () => ({ authRoutes: express.Router() }));
vi.mock('../../modules/dashboard/index.js', () => ({ dashboardRoutes: express.Router() }));
vi.mock('../../modules/dsa/index.js', () => ({ dsaRoutes: express.Router() }));
vi.mock('../../modules/activity/index.js', () => ({ activityRoutes: express.Router() }));
vi.mock('../../modules/projects/index.js', () => ({ projectsRoutes: express.Router() }));
vi.mock('../../modules/profile/index.js', () => ({ profileRoutes: express.Router() }));
vi.mock('../../modules/settings/index.js', () => ({ settingsRoutes: express.Router() }));
vi.mock('../../modules/platform-sync/index.js', () => ({ syncRoutes: express.Router() }));
vi.mock('../../shared/sse/index.js', () => ({ handleSseRequest: (_req: unknown, res: Response) => res.end() }));
vi.mock('../../modules/xp/xp.routes.js', () => ({ xpRoutes: express.Router() }));
vi.mock('../../modules/streak/index.js', () => ({ streakRoutes: express.Router() }));
vi.mock('../../modules/ops/ops.routes.js', () => ({ opsRoutes: express.Router() }));
vi.mock('../../modules/runtime-state/index.js', () => ({ runtimeStateRoutes: express.Router() }));
vi.mock('../../modules/observation/index.js', () => ({ observationRoutes: express.Router() }));
vi.mock('../../modules/missions/missions.routes.js', () => ({ default: express.Router() }));
vi.mock('../../modules/notifications/notification.routes.js', () => ({ default: express.Router() }));
vi.mock('../../modules/onboarding/onboarding.routes.js', () => ({ default: express.Router() }));
vi.mock('../../modules/daily-challenge/index.js', () => ({ dailyChallengeRoutes: express.Router() }));
vi.mock('../../modules/coaching/index.js', () => ({ coachingRoutes: express.Router() }));
vi.mock('../../modules/readiness/index.js', () => ({ readinessRoutes: express.Router() }));
vi.mock('../../modules/recommendations/recommendation.routes.js', () => ({ default: express.Router() }));
vi.mock('../../modules/analytics/analytics.routes.js', () => ({ default: express.Router() }));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1:1/unused_dt010');
  vi.stubEnv('CORS_ORIGIN', 'https://example.test');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_fixture_unused');
  vi.stubEnv('RATE_LIMIT_WINDOW_MS', '900000');
  vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', '100');
  const { default: routes } = await import('../../routes/index.js');
  const { mountApiRoutes } = await import('../../routes/mount.js');
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
  fixture.completed = false;
  // Date-only clock leaves HTTP and runner timers real.
  fixture.now += 900_001;
  vi.spyOn(Date, 'now').mockImplementation(() => fixture.now);
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function request(path: string, user = 'user-a', method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

describe('production resume HTTP chain', () => {
  it.each(['/api', '/api/v1'])('polls for six minutes through completion via %s', async prefix => {
    expect((await request(`${prefix}/resume/upload`, 'user-a', 'POST')).status).toBe(200);
    for (let poll = 0; poll < 240; poll++) {
      fixture.now += 1500;
      expect((await request(`${prefix}/resume/session/test-session/status`)).status, `poll ${poll + 1}`).toBe(200);
    }
    fixture.completed = true;
    expect((await request(`${prefix}/resume/session/test-session/status`)).body.data.currentStage).toBe('COMPLETED');
    expect((await request(`${prefix}/resume-intelligence/report/test-session`)).status).toBe(200);
    expect((await request(`${prefix}/resume-intelligence/report`, 'user-a', 'POST', { sessionId: 'test-session' })).status).toBe(200);
  }, 120_000);

  it('shares the processing budget across expensive operations, but isolates users at one IP', async () => {
    const operations = [
      ['/resume/upload', 'POST', undefined], ['/resume-intelligence/generate', 'POST', undefined],
      ['/resume-intelligence/variants', 'POST', { roleType: 'Backend' }],
      ['/resume-intelligence/ats-analysis', 'POST', {}], ['/resume-intelligence/credibility', 'GET', undefined],
    ] as const;
    for (const [path, method, body] of operations) {
      expect((await request(`/api${path}`, 'user-a', method, body)).status).toBe(200);
    }
    const blocked = await request('/api/resume-intelligence/report', 'user-a', 'POST', { sessionId: 'test-session' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('600');
    expect((await request('/api/resume/upload', 'user-b', 'POST')).status).toBe(200);
    expect((await request('/api/resume/session/test-session/status')).status).toBe(200);
    expect((await request('/api/resume-intelligence/report/test-session')).status).toBe(200);
  });

  it('limits read floods independently, recovers after expiry, and rejects invalid authentication', async () => {
    for (let read = 0; read < 120; read++) {
      expect((await request('/api/resume/session/test-session/status')).status).toBe(200);
    }
    const blocked = await request('/api/resume/session/test-session/status');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await request('/api/resume/session/test-session/status', 'user-b')).status).toBe(200);
    expect((await request('/api/resume/upload', 'user-a', 'POST')).status).toBe(200);
    fixture.now += 60_001;
    expect((await request('/api/resume/session/test-session/status')).status).toBe(200);
    expect((await request('/api/resume/session/test-session/status', 'invalid')).status).toBe(401);
    expect((await request('/api/resume-intelligence/report', 'user-b', 'POST', {})).status).toBe(400);
  });

  it('retains an IP flood guard even for unauthenticated polling', async () => {
    for (let read = 0; read < 600; read++) {
      expect((await request('/api/resume/session/test-session/status', 'invalid')).status).toBe(401);
    }
    const blocked = await request('/api/resume/session/test-session/status', 'invalid');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('30');
  }, 120_000);
});
