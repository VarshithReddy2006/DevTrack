import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { User, UserXp, UserAnalytics, XpTransaction, DsaProblem, Project, DailyActivity, Mission } from '../../../db/models/index.js';
import { getDashboard } from '../../../modules/dashboard/dashboard.service.js';
import { createActivity, incrementDailyActivity, deleteActivity } from '../../../modules/activity/activity.service.js';
import { createProblem, updateProblem, bulkUpdateStatus, deleteProblem } from '../../../modules/dsa/dsa.service.js';
import { createProject, updateProject, deleteProject } from '../../../modules/projects/projects.service.js';
import { connectPlatform } from '../../../modules/profile/profile.service.js';
import { syncPlatform } from '../../../modules/platform-sync/sync.service.js';
import { generateDailyMissions } from '../../../modules/missions/missionGenerator.service.js';
import { updateMissionProgress } from '../../../modules/missions/missionProgress.service.js';
import { processXpEvent } from '../../../modules/xp/processor.js';
import { recordActivity } from '../../../modules/streak/streak.service.js';
import { CACHE_KEYS } from '../../../shared/cache/cacheManager.js';
import { eventBus } from '../../../shared/sse/index.js';
import { entries, redis } from '../../fixtures/cacheRedis.js';

// Keep dashboard queries, cache policy, mutations and transactional XP real.
// Replace only external infrastructure/provider boundaries.
vi.mock('../../../shared/redis/client.js', async () => {
  const { redis } = await import('../../fixtures/cacheRedis.js');
  return { getRedisClient: () => redis };
});
vi.mock('../../../shared/sse/index.js', () => {
  const events = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  return { eventBus: new Proxy({}, { get: (_, key) => {
    if (!events.has(key)) events.set(key, vi.fn().mockResolvedValue(undefined));
    return events.get(key);
  } }) };
});
vi.mock('../../../shared/redis/syncLock.service.js', () => ({
  acquireSyncLockWithRetry: vi.fn().mockResolvedValue(true), releaseSyncLock: vi.fn(),
}));
vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: { updateFromEvent: vi.fn() },
}));
vi.mock('../../../shared/logger.js', () => ({ logger: {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), perf: vi.fn(),
} }));

const owner = '000000000000000000000093';
const other = '000000000000000000000094';
const key = CACHE_KEYS.dashboard(owner);
beforeAll(async () => {
  await Promise.all([User.init(), UserXp.init(), UserAnalytics.init(), XpTransaction.init()]);
});
beforeEach(async () => {
  entries.clear(); redis.status = 'ready'; redis.mget.mockReset(); redis.eval.mockReset();
  await User.create({ _id: owner, clerkId: 'clerk_cache', username: 'cacheowner',
    email: 'cache@example.test', displayName: 'Cache Owner', lastActiveAt: new Date() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('runs each dashboard aggregation once for ten cold requests and once more after expiry', async () => {
  const problemQuery = vi.spyOn(DsaProblem, 'aggregate');
  const projectQuery = vi.spyOn(Project, 'aggregate');
  const activityQuery = vi.spyOn(DailyActivity, 'aggregate');
  for (let batch = 1; batch <= 2; batch++) {
    const responses = await Promise.all(Array.from({ length: 10 }, () => getDashboard(owner)));
    expect(responses.every(response => response.stats.totalProblems === 0)).toBe(true);
    expect(problemQuery).toHaveBeenCalledTimes(batch);
    expect(projectQuery).toHaveBeenCalledTimes(batch);
    expect(activityQuery).toHaveBeenCalledTimes(batch);
    const hit = await getDashboard(owner);
    expect(hit).toEqual(JSON.parse(JSON.stringify(responses[0])));
    expect(problemQuery).toHaveBeenCalledTimes(batch);
    const entry = entries.get(key)!;
    expect(entry.expires! - Date.now()).toBeGreaterThan(290_000);
    entry.expires = Date.now() - 1;
  }
});

it('refreshes after activity creation, daily increments and deletion, isolating other users', async () => {
  const otherDashboard = await getDashboard(other);
  await getDashboard(owner);
  const activity = await createActivity(owner, { type: 'problem_solved', title: 'Accepted', description: '',
    platform: 'leetcode', url: null, tags: [], metadata: {} });
  const afterCreate = await getDashboard(owner);
  expect(afterCreate.recentActivity.map(item => item.id)).toContain(activity.id);
  expect(afterCreate.stats.totalActiveDays).toBe(1);
  expect(await getDashboard(other)).toEqual(otherDashboard);
  await incrementDailyActivity(owner, new Date(), 'sync');
  expect(entries.has(key)).toBe(false);
  await getDashboard(owner);
  expect(await deleteActivity(owner, activity.id)).toBe(true);
  expect((await getDashboard(owner)).recentActivity).toEqual([]);
});

it('refreshes after manual problem creation, updates, bulk status and deletion', async () => {
  await getDashboard(owner);
  const problem = await createProblem(owner, { title: 'Synthetic', platform: 'leetcode', difficulty: 'easy',
    category: 'arrays', tags: [], url: 'https://example.test/problem' });
  expect((await getDashboard(owner)).stats.totalProblems).toBe(1);
  await updateProblem(owner, problem.id, { status: 'solved' });
  expect((await getDashboard(owner)).stats.totalSubmissions).toBe(1);
  await bulkUpdateStatus(owner, [problem.id], 'unsolved');
  expect(entries.has(key)).toBe(false);
  await getDashboard(owner);
  await deleteProblem(owner, problem.id);
  expect((await getDashboard(owner)).stats.totalProblems).toBe(0);
});

it('invalidates immediately after project writes despite asynchronous activity logging', async () => {
  await getDashboard(owner);
  const project = await createProject(owner, { name: 'Cache project', description: 'Synthetic',
    status: 'in_progress', visibility: 'private', techStack: [] });
  expect((await getDashboard(owner)).stats.totalProjects).toBe(1);
  await updateProject(owner, project.id, { name: 'Updated project' });
  expect(entries.has(key)).toBe(false);
  await getDashboard(owner);
  await deleteProject(owner, project.id);
  expect((await getDashboard(owner)).stats.totalProjects).toBe(0);
});

it('refreshes missions after generation and progress without requiring an XP award', async () => {
  expect((await getDashboard(owner)).missions).toEqual([]);
  await generateDailyMissions();
  expect((await getDashboard(owner)).missions.length).toBeGreaterThan(0);
  // A non-completing mission proves invalidation does not depend on XP.
  await Mission.updateMany({ userId: owner, category: 'dsa' }, { $set: { targetCount: 100 } });
  await updateMissionProgress(owner, 'dsa_solve', { difficulty: 'easy' });
  const view = await getDashboard(owner);
  expect(view.missions.some(mission => mission.currentCount === 1)).toBe(true);
});

it('retains invalidation from real committed XP awards and streak recalculation', async () => {
  expect((await getDashboard(owner)).stats.weeklyConsistencyScore).toBe(0);
  vi.mocked(eventBus.emitXpUpdated).mockImplementationOnce(() => { expect(entries.has(key)).toBe(false); });
  await processXpEvent({ userId: owner, sourceType: 'focus_session', sourceId: 'synthetic-focus' });
  expect((await getDashboard(owner)).stats.weeklyConsistencyScore).toBeGreaterThan(0);
  await recordActivity({ userId: owner, streakType: 'dsa', source: 'cache-test' });
  expect(entries.has(key)).toBe(false);
});

it('invalidates on platform connection and on sync after final stats are persisted', async () => {
  expect((await getDashboard(owner)).platformStats).toEqual([]);
  await connectPlatform(owner, 'github', 'cacheowner');
  expect((await getDashboard(owner)).platformStats).toHaveLength(1);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/repos?')
    ? Response.json([{ stargazers_count: 7, language: 'TypeScript' }])
    : Response.json({ public_repos: 3, followers: 4, following: 1 })));
  vi.mocked(eventBus.emitSyncCompleted).mockImplementationOnce(() => { expect(entries.has(key)).toBe(false); });
  expect(await syncPlatform(owner, 'github')).toMatchObject({ success: true });
  expect((await getDashboard(owner)).githubStats).toMatchObject({ repos: 3, totalStars: 7 });
});

it('returns successful writes and fresh uncached reads when Redis rejects commands', async () => {
  redis.mget.mockRejectedValue(new Error('Redis offline'));
  redis.eval.mockRejectedValue(new Error('Redis offline'));
  await createActivity(owner, { type: 'problem_solved', title: 'Accepted', description: '',
    platform: 'leetcode', url: null, tags: [], metadata: {} });
  expect((await getDashboard(owner)).recentActivity).toHaveLength(1);
});

it('invalidates a persisted activity event even when the later daily counter write fails', async () => {
  await getDashboard(owner);
  vi.spyOn(DailyActivity, 'findOneAndUpdate').mockRejectedValueOnce(new Error('counter write failed'));
  await expect(createActivity(owner, { type: 'problem_solved', title: 'Persisted event', description: '',
    platform: 'leetcode', url: null, tags: [], metadata: {} })).rejects.toThrow('counter write failed');
  expect((await getDashboard(owner)).recentActivity.map(activity => activity.title)).toEqual(['Persisted event']);
});
