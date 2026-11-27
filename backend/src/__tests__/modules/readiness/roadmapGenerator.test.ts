// Target role roadmap generator (#441): milestone sequencing from real skill gaps, the LLM path
// through a mocked gateway, the rule-based fallback, persistence, task completion and validation.
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CareerRoadmap } from '../../../db/models/careerRoadmap.model.js';
import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { ReadinessInput } from '../../../db/models/readinessInput.model.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { UserSkillProgress } from '../../../db/models/userSkillProgress.model.js';
import { errorHandler } from '../../../middleware/error.js';
import { readinessRoutes } from '../../../modules/readiness/index.js';
import { planMilestones } from '../../../modules/readiness/roadmapGenerator.service.js';
import { mountApiRoutes } from '../../../routes/mount.js';

const mocks = vi.hoisted(() => ({ complete: vi.fn(), aiLimited: 0 }));

vi.mock('../../../middleware/auth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../middleware/auth.js')>()),
  authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = req.get('x-test-user');
    if (!id) return res.sendStatus(401);
    Object.assign(req, { user: { id } });
    next();
  },
}));

vi.mock('../../../middleware/rateLimitAdvanced.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../middleware/rateLimitAdvanced.js')>();
  return {
    ...actual,
    rateLimiters: {
      ...actual.rateLimiters,
      ai: (_req: express.Request, _res: express.Response, next: express.NextFunction) => { mocks.aiLimited++; next(); },
    },
  };
});

vi.mock('../../../modules/ai/provider/LLMGateway.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../modules/ai/provider/LLMGateway.js')>()),
  llmGateway: { generateCompletion: mocks.complete },
}));

const user = new Types.ObjectId().toHexString();
const other = new Types.ObjectId().toHexString();
let server: Server;
let origin: string;

function request(path: string, method = 'GET', body?: object, as: string | null = user) {
  return fetch(`${origin}/api/v2/readiness/roadmap${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(as ? { 'x-test-user': as } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function generate(body: object, as = user) {
  const res = await request('/generate', 'POST', body, as);
  return { status: res.status, body: await res.json() };
}

const aiMilestone = (n: number) => ({
  objective: `AI objective ${n}`,
  projectArchitecture: `AI architecture ${n}`,
  keyConcepts: [`Concept ${n}a`, `Concept ${n}b`],
  dsaPatterns: ['Sliding window'],
  verificationCriteria: [`Measure thing ${n}`],
});

const gatewayReply = (content: string, provider = 'gemini') => ({
  content, provider, model: 'test-model', tokensUsed: 10, latencyMs: 1, cached: false, cacheHit: false,
  cost: 0, fallbackTriggered: false, promptHash: 'hash',
});

beforeAll(async () => {
  await Promise.all([CareerRoadmap.init(), ReadinessInput.init(), UserSkillProgress.init()]);
  const app = express();
  const router = express.Router();
  router.use('/readiness', readinessRoutes);
  app.use(express.json());
  mountApiRoutes(app, router);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(async () => {
  mocks.complete.mockReset();
  mocks.aiLimited = 0;
  vi.stubEnv('GEMINI_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  // Backend Developer requires 11 skills; these four are already covered.
  await ResumeProfile.create({ userId: user, targetRole: 'Backend', selectedSkills: ['NodeJS', 'Express', 'Mongo'] });
  await UserSkillProgress.create({ userId: user, skill: 'sql', completed: true });
  await ReadinessCore.create({ userId: user, overallScore: 55 });
});

afterEach(() => vi.unstubAllEnvs());

describe('planMilestones', () => {
  it('groups skills into ordered 2-week blocks and defers what does not fit', () => {
    const skills = Array.from({ length: 20 }, (_, i) => `S${i + 1}`);
    const { plans, deferredSkills } = planMilestones(skills, 4);
    expect(plans.map(p => [p.startWeek, p.endWeek, p.skills])).toEqual([
      [1, 2, ['S1', 'S2', 'S3']],
      [3, 4, ['S4', 'S5', 'S6']],
    ]);
    expect(deferredSkills).toEqual(skills.slice(6));
  });

  it('ends the last block on an odd deadline and never makes empty milestones', () => {
    expect(planMilestones(['A', 'B', 'C', 'D', 'E'], 5).plans.map(p => [p.startWeek, p.endWeek, p.skills.length]))
      .toEqual([[1, 2, 2], [3, 4, 2], [5, 5, 1]]);
    expect(planMilestones(['A'], 10).plans).toHaveLength(1);
  });
});

describe('POST /api/v2/readiness/roadmap/generate', () => {
  it('builds sequenced milestones from the actual missing skills with the template when no provider is set', async () => {
    const { status, body } = await generate({ targetRoleId: 'backend-developer', targetDeadlineWeeks: 6 });

    expect(status).toBe(201);
    const roadmap = body.data;
    expect(roadmap).toMatchObject({
      targetRoleId: 'backend-developer', targetRole: 'Backend Developer', targetSource: 'role_catalog',
      targetDeadlineWeeks: 6, baselineReadinessScore: 55, source: 'template', degradedReason: 'ai_unconfigured',
      missingSkills: ['Docker', 'Redis', 'Testing', 'CI/CD', 'System Design', 'Authentication', 'Caching'],
      deferredSkills: [], progress: 0,
    });
    expect(roadmap.milestones.map((m: { sequence: number; startWeek: number; endWeek: number; skills: string[] }) =>
      [m.sequence, m.startWeek, m.endWeek, m.skills])).toEqual([
      [1, 1, 2, ['Docker', 'Redis', 'Testing']],
      [2, 3, 4, ['CI/CD', 'System Design']],
      [3, 5, 6, ['Authentication', 'Caching']],
    ]);
    for (const milestone of roadmap.milestones) {
      expect(milestone.objective).toContain('Backend Developer');
      expect(milestone.projectArchitecture.length).toBeGreaterThan(0);
      expect(milestone.keyConcepts.length).toBeGreaterThan(0);
      expect(milestone.dsaPatterns.length).toBeGreaterThan(0);
      expect(milestone.verificationCriteria.length).toBeGreaterThan(0);
      expect(new Set(milestone.tasks.map((t: { kind: string }) => t.kind))).toEqual(new Set(['learn', 'build', 'practice', 'verify']));
      expect(milestone.tasks.every((t: { completed: boolean }) => !t.completed)).toBe(true);
    }
    expect(roadmap.milestones[0].verificationCriteria.join(' ')).toMatch(/replication.*failover/i);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.aiLimited).toBe(1);

    const stored = await CareerRoadmap.find({ userId: user }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].milestones).toHaveLength(3);
  });

  it('uses the latest parsed job target skills and the model output when a provider answers', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    await ReadinessInput.create({
      userId: new Types.ObjectId(user),
      jobTargets: {
        targetIds: ['jt-1'],
        latest: { jobTargetId: 'jt-1', targetRole: 'Distributed Systems Engineer', requiredSkills: ['Redis', 'Node.js', 'Kafka'], parsedAt: new Date() },
      },
    });
    mocks.complete.mockResolvedValue(gatewayReply(JSON.stringify({ milestones: [aiMilestone(1), aiMilestone(2)] })));

    const { status, body } = await generate({ targetRoleId: 'jt-1' });

    expect(status).toBe(201);
    expect(body.data).toMatchObject({
      targetSource: 'job_target', targetRole: 'Distributed Systems Engineer', source: 'ai', degradedReason: null,
      missingSkills: ['Redis', 'Kafka'], targetDeadlineWeeks: 4,
    });
    expect(body.data.milestones.map((m: { skills: string[] }) => m.skills)).toEqual([['Redis'], ['Kafka']]);
    expect(body.data.milestones[1]).toMatchObject(aiMilestone(2));
    expect(body.data.milestones[1].tasks.map((t: { taskId: string; title: string }) => [t.taskId, t.title])).toEqual([
      ['m2-t1', 'Learn: Concept 2a'],
      ['m2-t2', 'Learn: Concept 2b'],
      ['m2-t3', 'Build: AI architecture 2'],
      ['m2-t4', 'Practise DSA: Sliding window'],
      ['m2-t5', 'Verify: Measure thing 2'],
    ]);
    const call = mocks.complete.mock.calls[0][0];
    expect(call).toMatchObject({ userId: user, feature: 'roadmap' });
    expect(call.prompt).toContain('<roadmap_untrusted_text>');
    expect(call.prompt).toContain('Kafka');
    expect(call.prompt).toContain('readiness score (0-100): 55');
  });

  it.each([
    ['the gateway falls back to its heuristic', () => mocks.complete.mockResolvedValue(gatewayReply('', 'heuristic')), 'llm_failed'],
    ['the provider throws', () => mocks.complete.mockRejectedValue(new Error('provider down')), 'llm_failed'],
    ['the reply is not JSON', () => mocks.complete.mockResolvedValue(gatewayReply('Here is your roadmap!')), 'invalid_output'],
    ['the reply has the wrong milestone count', () => mocks.complete.mockResolvedValue(gatewayReply(JSON.stringify({ milestones: [aiMilestone(1)] }))), 'invalid_output'],
  ])('uses the rule-based template when %s', async (_case, arrange, reason) => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    arrange();

    const { status, body } = await generate({ targetRoleId: 'Backend Developer', targetDeadlineWeeks: 4 });

    expect(status).toBe(201);
    expect(body.data).toMatchObject({ targetRoleId: 'backend-developer', source: 'template', degradedReason: reason });
    expect(body.data.milestones).toHaveLength(2);
    expect(body.data.milestones[0].objective).toContain('Docker');
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, 400],
    [{ targetRoleId: '' }, 400],
    [{ targetRoleId: 'backend-developer', targetDeadlineWeeks: 1 }, 400],
    [{ targetRoleId: 'backend-developer', targetDeadlineWeeks: 53 }, 400],
    [{ targetRoleId: 'backend-developer', targetDeadlineWeeks: 3.5 }, 400],
    [{ targetRoleId: 'backend-developer', targetDeadlineWeeks: '6' }, 400],
    [{ targetRoleId: 'quantum-baker' }, 404],
  ])('rejects %j with %i', async (payload, expected) => {
    const { status, body } = await generate(payload);
    expect(status).toBe(expected);
    expect(body.success).toBe(false);
    if (expected === 404) expect(body.code).toBe('TARGET_ROLE_NOT_FOUND');
    expect(await CareerRoadmap.countDocuments()).toBe(0);
  });

  it('does not use a job target that is not the latest parse', async () => {
    await ReadinessInput.create({
      userId: new Types.ObjectId(user),
      jobTargets: { targetIds: ['jt-old', 'jt-new'], latest: { jobTargetId: 'jt-new', requiredSkills: ['Kafka'], parsedAt: new Date() } },
    });
    expect((await generate({ targetRoleId: 'jt-old' })).status).toBe(404);
  });

  it('returns 409 when the user already covers every required skill', async () => {
    await ReadinessInput.create({
      userId: new Types.ObjectId(user),
      jobTargets: { targetIds: ['jt-1'], latest: { jobTargetId: 'jt-1', requiredSkills: ['Node.js', 'SQL'], parsedAt: new Date() } },
    });
    const { status, body } = await generate({ targetRoleId: 'jt-1' });
    expect(status).toBe(409);
    expect(body.code).toBe('NO_SKILL_GAPS');
  });

  it('requires authentication', async () => {
    const res = await request('/generate', 'POST', { targetRoleId: 'backend-developer' }, null);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v2/readiness/roadmap', () => {
  it('returns 404 before generation and the latest roadmap after regeneration', async () => {
    const empty = await request('');
    expect(empty.status).toBe(404);
    expect((await empty.json()).code).toBe('ROADMAP_NOT_FOUND');

    await generate({ targetRoleId: 'backend-developer', targetDeadlineWeeks: 6 });
    await generate({ targetRoleId: 'backend-developer', targetDeadlineWeeks: 2 });

    const res = await request('');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.targetDeadlineWeeks).toBe(2);
    expect(data.milestones).toHaveLength(1);
    expect(data.deferredSkills).toEqual(['CI/CD', 'System Design', 'Authentication', 'Caching']);
    expect(await CareerRoadmap.countDocuments({ userId: user })).toBe(1);
  });
});

describe('PATCH /api/v2/readiness/roadmap/milestones/:milestoneId/tasks/:taskId', () => {
  const toggle = (milestoneId: string, taskId: string, body: object, as = user) =>
    request(`/milestones/${milestoneId}/tasks/${taskId}`, 'PATCH', body, as);

  it('toggles a task, keeps the first completion time on repeats and derives milestone completion', async () => {
    const { body } = await generate({ targetRoleId: 'backend-developer', targetDeadlineWeeks: 6 });
    const tasks: Array<{ taskId: string }> = body.data.milestones[2].tasks;

    const first = await (await toggle('m3', tasks[0].taskId, { completed: true })).json();
    const task = first.data.milestones[2].tasks[0];
    expect(task.completed).toBe(true);
    expect(task.completedAt).toBeTruthy();
    expect(first.data.milestones[2].completed).toBe(false);

    const repeat = await (await toggle('m3', tasks[0].taskId, { completed: true })).json();
    expect(repeat.data.milestones[2].tasks[0].completedAt).toBe(task.completedAt);

    const undone = await (await toggle('m3', tasks[0].taskId, { completed: false })).json();
    expect(undone.data.milestones[2].tasks[0]).toMatchObject({ completed: false, completedAt: null });

    let last;
    for (const { taskId } of tasks) last = await (await toggle('m3', taskId, { completed: true })).json();
    expect(last.data.milestones[2]).toMatchObject({ completed: true, progress: 100 });
    expect(last.data.milestones[2].completedAt).toBeTruthy();
    expect(last.data.milestones[0]).toMatchObject({ completed: false, progress: 0 });
    expect(last.data.progress).toBeGreaterThan(0);
    expect(last.data.progress).toBeLessThan(100);

    const stored = await CareerRoadmap.findOne({ userId: user }).lean();
    expect(stored!.milestones[2].tasks.every(t => t.completed)).toBe(true);
    expect(stored!.milestones[0].tasks.some(t => t.completed)).toBe(false);
  });

  it('returns 404 for unknown tasks and for another user\'s roadmap', async () => {
    await generate({ targetRoleId: 'backend-developer', targetDeadlineWeeks: 6 });
    expect((await toggle('m1', 'm1-t99', { completed: true })).status).toBe(404);
    expect((await toggle('m9', 'm1-t1', { completed: true })).status).toBe(404);
    expect((await toggle('m1', 'm1-t1', { completed: true }, other)).status).toBe(404);
    const stored = await CareerRoadmap.findOne({ userId: user }).lean();
    expect(stored!.milestones[0].tasks[0].completed).toBe(false);
  });

  it('rejects a body without a boolean completed flag', async () => {
    await generate({ targetRoleId: 'backend-developer', targetDeadlineWeeks: 6 });
    expect((await toggle('m1', 'm1-t1', { completed: 'yes' })).status).toBe(400);
    expect((await toggle('m1', 'm1-t1', {})).status).toBe(400);
  });

  it('returns curated learning resources for GET /readiness/roadmap/resource and rejects missing skill', async () => {
    const res = await request('/resource?skill=React', 'GET');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.skill).toBe('React');
    expect(body.data.practiceProject?.title).toBeTruthy();

    const missing = await request('/resource', 'GET');
    expect(missing.status).toBe(400);
  });
});
