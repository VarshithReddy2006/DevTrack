import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UserConceptProgress } from '../../../db/models/userConceptProgress.model.js';
import { errorHandler } from '../../../middleware/error.js';
import { readinessRoutes } from '../../../modules/readiness/index.js';
import { getPlacementRadar } from '../../../modules/readiness/placementRadar.service.js';
import { CS_CONCEPTS_CATALOG } from '../../../modules/readiness/concepts/csConceptsCatalog.js';
import { SYSTEM_DESIGN_CATALOG } from '../../../modules/readiness/concepts/systemDesignCatalog.js';
import { mountApiRoutes } from '../../../routes/mount.js';

vi.mock('../../../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../middleware/auth.js')>()),
  authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = req.get('x-test-user');
    if (!id) return res.sendStatus(401);
    Object.assign(req, { user: { id } });
    next();
  },
}));

const user = new Types.ObjectId().toHexString();
const other = new Types.ObjectId().toHexString();
let server: Server;
let origin: string;

function request(path: string, method = 'GET', body?: object, as: string | null = user) {
  return fetch(`${origin}/api/v1/readiness/concepts${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(as ? { 'x-test-user': as } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  await UserConceptProgress.init();
  const app = express();
  app.use(express.json());
  const routes = express.Router();
  routes.use('/readiness', readinessRoutes);
  mountApiRoutes(app, routes);
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await UserConceptProgress.deleteMany({ userId: { $in: [user, other] } });
  server.closeIdleConnections();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

describe('System Design & CS Concepts Workspaces API + Placement Radar Link', () => {
  it('requires auth and serves System Design & CS Concepts catalogs', async () => {
    expect((await request('/system-design', 'GET', undefined, null)).status).toBe(401);

    const sdRes = await request('/system-design');
    expect(sdRes.status).toBe(200);
    const sdBody = await sdRes.json();
    expect(sdBody.data.domain).toBe('system-design');
    expect(sdBody.data.concepts).toHaveLength(SYSTEM_DESIGN_CATALOG.length);
    expect(sdBody.data.summary.completedConcepts).toBe(0);

    const csRes = await request('/cs-concepts');
    expect(csRes.status).toBe(200);
    const csBody = await csRes.json();
    const expectedCoreCount = CS_CONCEPTS_CATALOG.filter((c) => !c.isOptional).length;
    const expectedOptionalCount = CS_CONCEPTS_CATALOG.filter((c) => c.isOptional).length;
    expect(csBody.data.domain).toBe('cs-concepts');
    expect(csBody.data.summary.coreTotal).toBe(expectedCoreCount);
    expect(csBody.data.summary.optionalTotal).toBe(expectedOptionalCount);
    expect(expectedOptionalCount).toBeGreaterThanOrEqual(6);
  });

  it('persists concept progress per owner and excludes optional Distributed Systems from Core CS score', async () => {
    const coreTopics = CS_CONCEPTS_CATALOG.filter((c) => !c.isOptional);
    const optionalTopics = CS_CONCEPTS_CATALOG.filter((c) => c.isOptional);

    // Completing an optional Distributed Systems concept does NOT penalize or inflate Core CS score
    const optRes = await request(`/cs-concepts/${optionalTopics[0].id}`, 'PATCH', {
      completed: true,
      confidence: 'got_it',
    });
    expect(optRes.status).toBe(200);
    const optJson = await optRes.json();
    expect(optJson.data.summary.optionalCompleted).toBe(1);
    expect(optJson.data.summary.coreCompleted).toBe(0);
    expect(optJson.data.summary.coreProgressPercent).toBe(0);

    // Other user remains completely isolated
    const otherRes = await request('/cs-concepts', 'GET', undefined, other);
    const otherJson = await otherRes.json();
    expect(otherJson.data.summary.optionalCompleted).toBe(0);

    // Complete all Core CS fundamentals while leaving optional Distributed Systems untouched for `other`
    for (const topic of coreTopics) {
      await request(`/cs-concepts/${topic.id}`, 'PATCH', { completed: true }, other);
    }
    const coreFullRes = await request('/cs-concepts', 'GET', undefined, other);
    const coreFullJson = await coreFullRes.json();
    expect(coreFullJson.data.summary.coreCompleted).toBe(coreTopics.length);
    expect(coreFullJson.data.summary.coreProgressPercent).toBe(100);
    expect(coreFullJson.data.summary.optionalCompleted).toBe(0);

    // Validation & 404 guards
    expect((await request('/invalid-domain', 'GET')).status).toBe(400);
    expect(
      (await request('/system-design/nonexistent-id', 'PATCH', { completed: true })).status
    ).toBe(404);
    expect((await request('/system-design/sd-api-protocols', 'PATCH', {})).status).toBe(400);
  });

  it('feeds mastered System Design and Core CS concepts dynamically into Placement Radar without Distributed Systems penalty', async () => {
    // Complete 9 of 18 System Design concepts -> 50/100 architecture axis
    for (const item of SYSTEM_DESIGN_CATALOG.slice(0, 9)) {
      await request(`/system-design/${item.id}`, 'PATCH', {
        completed: true,
        confidence: 'got_it',
      });
    }

    // Complete ALL Core CS concepts -> 100/100 Core CS axis even with 0 Distributed Systems completed
    const coreTopics = CS_CONCEPTS_CATALOG.filter((c) => !c.isOptional);
    for (const item of coreTopics) {
      await request(`/cs-concepts/${item.id}`, 'PATCH', {
        completed: true,
      });
    }

    const now = new Date();
    const radar = await getPlacementRadar(user, now);
    const archAxis = radar.axes.find((a) => a.key === 'architecture');
    const csAxis = radar.axes.find((a) => a.key === 'coreCs');

    expect(archAxis?.score).toBe(Math.round((9 / SYSTEM_DESIGN_CATALOG.length) * 100));
    expect(archAxis?.evidence[0]).toContain(`System Design: 9/${SYSTEM_DESIGN_CATALOG.length} concepts mastered`);

    expect(csAxis?.score).toBe(100);
    expect(csAxis?.evidence[0]).toContain(`Core CS: ${coreTopics.length}/${coreTopics.length} fundamentals mastered`);

    // Verify live HTTP endpoint returns identical live scores
    const httpRadarRes = await fetch(`${origin}/api/v1/readiness/placement-radar`, {
      headers: { 'x-test-user': user },
    });
    expect(httpRadarRes.status).toBe(200);
    const httpJson = await httpRadarRes.json();
    const httpArch = httpJson.data.axes.find((a: { key: string }) => a.key === 'architecture');
    const httpCs = httpJson.data.axes.find((a: { key: string }) => a.key === 'coreCs');
    expect(httpArch.score).toBe(50);
    expect(httpCs.score).toBe(100);
  });
});
