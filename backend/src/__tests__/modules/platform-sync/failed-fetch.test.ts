import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectedPlatform, DsaTopicProgress, PlatformStats, SyncJob } from '../../../db/models/index.js';
import { syncPlatform } from '../../../modules/platform-sync/sync.service.js';
import { getAdapter } from '../../../modules/platform-sync/adapters/index.js';
import { circuitBreakers } from '../../../shared/circuit-breaker/circuitBreaker.js';

vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitSyncStarted: vi.fn(), emitSyncCompleted: vi.fn(), emitSyncFailed: vi.fn() } }));
vi.mock('../../../shared/redis/syncLock.service.js', () => ({
  acquireSyncLockWithRetry: vi.fn().mockResolvedValue(true), releaseSyncLock: vi.fn(),
}));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getReadinessDsaQueue: () => ({ add: vi.fn() }) }));
vi.mock('../../../modules/daily-challenge/daily-challenge.service.js', () => ({ checkChallengeCompletion: vi.fn().mockResolvedValue(false) }));

const userId = '000000000000000000000753';
const accepted = (index: number) => ({ id: index, verdict: 'OK', creationTimeSeconds: 1, problem: { contestId: 4, index: String(index) } });

/** Codeforces stub where only the solved count requests (count=5000) are controlled by the test. */
function codeforces(solvedPage: (from: number) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('user.info')) return Response.json({ status: 'OK', result: [{ handle: 'synthetic', rating: 1500 }] });
    if (url.includes('user.rating')) return Response.json({ status: 'OK', result: [] });
    const params = new URL(url).searchParams;
    if (params.get('count') === '5000') return solvedPage(Number(params.get('from')));
    return Response.json({ status: 'OK', result: [] });
  }));
}
const codechef = (html: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(html)));

async function seed(platformName: 'codeforces' | 'codechef', topicName: string) {
  await ConnectedPlatform.create({ userId, platformName, username: 'synthetic', profileUrl: 'https://example.test' });
  await PlatformStats.create({ userId, platformName, username: 'synthetic', totalSolved: 300, rating: 1800 });
  await DsaTopicProgress.create({ userId, topicName, solvedCount: 300, totalProblems: 300 });
}

async function expectStatsKept(platformName: 'codeforces' | 'codechef') {
  const result = await syncPlatform(userId, platformName, { force: true });
  expect(result.success).toBe(false);
  expect(await PlatformStats.findOne({ userId, platformName }).lean()).toMatchObject({ totalSolved: 300, rating: 1800 });
  expect(await DsaTopicProgress.findOne({ userId }).lean()).toMatchObject({ solvedCount: 300, totalProblems: 300 });
  expect(await ConnectedPlatform.findOne({ userId, platformName }).lean()).toMatchObject({ syncStatus: 'error', syncError: result.error });
  expect(await SyncJob.findOne({ userId, platformName }).lean()).toMatchObject({ status: 'failed' });
}

beforeEach(() => { for (const breaker of Object.values(circuitBreakers)) breaker.reset(); });
afterEach(() => { vi.unstubAllGlobals(); });

it.each([
  ['a rejected request', () => Response.json({ status: 'FAILED', comment: 'Call limit exceeded' }, { status: 400 })],
  ['a FAILED body with status 200', () => Response.json({ status: 'FAILED' })],
  ['a body without a result list', () => Response.json({ status: 'OK' })],
  ['a non JSON body', () => new Response('<html>maintenance</html>')],
])('keeps Codeforces stats when the solved count gets %s', async (_name, response) => {
  await seed('codeforces', 'Competitive Programming');
  codeforces(response);
  await expectStatsKept('codeforces');
});

it('does not store a partial Codeforces count when a later page fails', async () => {
  await seed('codeforces', 'Competitive Programming');
  codeforces(from => from === 1
    ? Response.json({ status: 'OK', result: Array.from({ length: 5000 }, (_, i) => accepted(i)) })
    : Response.json({ status: 'FAILED' }, { status: 400 }));
  await expectStatsKept('codeforces');
});

it('still accepts a Codeforces account with no submissions', async () => {
  codeforces(() => Response.json({ status: 'OK', result: [] }));
  expect(await getAdapter('codeforces').sync('synthetic')).toMatchObject({ success: true, stats: { totalSolved: 0 } });
});

it.each([
  ['a bot check page', '<html><title>Just a moment...</title><body>Checking your browser</body></html>'],
  ['a rating but no solved count', '<div class="rating-number">1800</div>'],
  ['only unrelated headings', '<section class="problems-solved"><h5>Problems Authored (216)</h5></section>'],
])('keeps CodeChef stats when the page has %s', async (_name, html) => {
  await seed('codechef', 'CodeChef Problems');
  codechef(html);
  await expectStatsKept('codechef');
});

// Shape of a current profile page: the total sits in an h3, other h5 headings come with numbers.
const profilePage = (solved: string) => `<section class="rating-data-section problems-solved"><h3>Contests (0)</h3>
  <h3>Total Problems Solved: ${solved}</h3></section><section class="rating-data-section problems-solved">
  <h3>Contributions</h3><h5 class="collapse">Problems Authored (216)</h5></section>`;

it.each([['0', 0], ['2,930', 2930]])('reads a CodeChef total of %s', async (text, expected) => {
  codechef(profilePage(text));
  expect(await getAdapter('codechef').sync('synthetic')).toMatchObject({ success: true, stats: { totalSolved: expected } });
});
