import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAdapter, LeetCodeAdapter, CodeforcesAdapter, CodeChefAdapter, GitHubAdapter } from './index.js';
import { circuitBreakers } from '../../../shared/circuit-breaker/circuitBreaker.js';
import { fetchWithRetry } from './http.js';

vi.mock('../../../shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../config/env.js', () => ({ env: { GITHUB_TOKEN: 'synthetic-test-token' } }));
const seconds = Math.floor(Date.now() / 1000);
const attempt = { id: '123', title: 'Two Sum', titleSlug: 'two-sum', timestamp: String(seconds) };
const cfRow = { id: 1, verdict: 'OK', creationTimeSeconds: seconds, programmingLanguage: 'C++',
  problem: { contestId: 4, index: 'A', name: 'Watermelon', rating: 800 } };
const lcProfile = { data: { matchedUser: { submitStatsGlobal: { acSubmissionNum: [
  { difficulty: 'All', count: 10 }, { difficulty: 'Easy', count: 4 }, { difficulty: 'Medium', count: 5 }, { difficulty: 'Hard', count: 1 },
] }, submissionCalendar: JSON.stringify({ [seconds]: 2, invalid: 1, 42: -1 }) },
userContestRanking: { attendedContestsCount: 2, rating: 1800.4 } } };
const ccHtml = `<div class="rating-number">1650</div><div class="rating-header"><span class="highest">Highest 1700</span></div>
  <div class="profile-loaction-item">Global Rank: 1,234</div><section class="problems-solved"><h5>Total Problems Solved: 277</h5></section>
  <span class="rating-star">3★</span>Country Rank: 99`;

function provider(overrides: { lc?: unknown; submissions?: unknown; cf?: unknown; html?: string; status?: number } = {}) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (overrides.status) return new Response('provider error', { status: overrides.status });
    if (url === 'https://leetcode.com/graphql') {
      const query = JSON.parse(String(init?.body)).query as string;
      return Response.json(query.includes('recentAcSubmissions')
        ? { data: { recentAcSubmissionList: overrides.submissions ?? [attempt] } } : overrides.lc ?? lcProfile);
    }
    if (url.includes('alfa-leetcode')) return Response.json({ contestHistory: [
      { title: 'Weekly', startTime: seconds, participantCount: 100 }, { title: '', startTime: 0 }, { title: 'Invalid', startTime: 'bad' },
    ] });
    if (url.includes('user.info')) return Response.json({ status: 'OK', result: [{ handle: 'alice', rating: 1500, rank: 'specialist' }] });
    if (url.includes('user.rating')) return Response.json({ status: 'OK', result: [{ contestId: 1, contestName: 'Round', rank: 10,
      oldRating: 1400, newRating: 1500, ratingUpdateTimeSeconds: seconds }] });
    if (url.includes('user.status')) return Response.json({ status: 'OK', result: overrides.cf ?? [cfRow] });
    if (url.includes('codechef.com')) return new Response(overrides.html ?? ccHtml);
    if (url.includes('/repos?')) return Response.json([{ stargazers_count: 7, language: 'TypeScript' }, { language: 'Python' }, {}]);
    if (url.includes('api.github.com/users/')) return Response.json({ public_repos: 3, followers: 4, following: 1, name: 'Alice' });
    return new Response('unexpected synthetic URL', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => { for (const breaker of Object.values(circuitBreakers)) breaker.reset(); provider(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['leetcode', 'codeforces', 'codechef', 'github'])('syncs %s through its registered adapter', async platform => {
  const adapter = getAdapter(platform);
  const result = await adapter.sync('alice /test');
  expect(result.success).toBe(true);
  expect(result.stats.platform).toBe(platform);
  expect(result.profile?.profileUrl).toContain('alice%20%2Ftest');
  expect(result.stats.totalSolved).toBeGreaterThan(0);
});
it('rejects unknown platforms', () => { expect(() => getAdapter('unsupported')).toThrow('No adapter registered'); });

it('normalizes LeetCode IDs, composite fallbacks, dates, filtering and calendar data', async () => {
  const fetcher = provider({ submissions: [attempt, { ...attempt, id: '124', timestamp: String(seconds - 1) },
    { ...attempt, id: undefined }, { ...attempt, id: null, timestamp: String(seconds - 2) },
    { ...attempt, timestamp: 'invalid' }, { title: 'Missing slug', timestamp: String(seconds) }] });
  const adapter = new LeetCodeAdapter();
  const rows = await adapter.fetchSubmissions('alice', new Date((seconds - 1) * 1000));
  expect(rows.map(row => row.externalId)).toEqual(['123', '124', `two-sum:${seconds}`]);
  expect(rows.every(row => row.problemExternalId === 'two-sum')).toBe(true);
  expect(rows[0].submittedAt).toEqual(new Date(seconds * 1000));
  const stats = await adapter.fetchStats('alice');
  expect(stats).toMatchObject({ totalSolved: 10, easySolved: 4, mediumSolved: 5, hardSolved: 1, rating: 1800, totalContests: 2 });
  expect(stats.rawData.submissionCalendar).toMatchObject({ [new Date(seconds * 1000).toISOString().slice(0, 10)]: 2 });
  expect(fetcher.mock.calls.some(([, init]) => JSON.parse(String(init?.body ?? '{}')).variables?.limit === 500)).toBe(true);
});
it.each([{}, { data: {} }])('rejects absent LeetCode users', async data => {
  provider({ lc: data });
  expect((await new LeetCodeAdapter().sync('missing')).success).toBe(false);
});
it('handles empty LeetCode stats and invalid calendar JSON without fabricating counts', async () => {
  provider({ lc: { data: { matchedUser: { submitStatsGlobal: { acSubmissionNum: [] }, submissionCalendar: '{bad' } } } });
  expect(await new LeetCodeAdapter().fetchStats('alice')).toMatchObject({ totalSolved: 0, rating: null, totalContests: 0 });
});
it('rejects malformed submissions while optional contest failures remain nonfatal', async () => {
  provider({ submissions: {} });
  await expect(new LeetCodeAdapter().fetchSubmissions('alice')).rejects.toThrow('Invalid LeetCode');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
  expect(await new LeetCodeAdapter().fetchContests('alice', {} as never)).toEqual([]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json('bad')));
  expect(await new LeetCodeAdapter().fetchContests('alice', {} as never)).toEqual([]);
});

it('preserves every Codeforces verdict and difficulty and excludes old/invalid rows', async () => {
  provider({ cf: [cfRow, ...['WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'COMPILATION_ERROR'].map((verdict, i) =>
    ({ ...cfRow, id: i + 2, verdict, problem: { ...cfRow.problem, rating: [1500, 2200, 0, 800][i] } })),
    { ...cfRow, creationTimeSeconds: 'bad' }, { ...cfRow, id: null }, { ...cfRow, verdict: undefined },
    { ...cfRow, problem: undefined }, { ...cfRow, creationTimeSeconds: 1 }] });
  const rows = await new CodeforcesAdapter().fetchSubmissions('alice', new Date((seconds - 100) * 1000));
  expect(rows.map(row => row.status)).toEqual(['accepted', 'wrong_answer', 'time_limit', 'runtime_error', 'compilation_error']);
  expect(rows.map(row => row.difficulty)).toEqual(['easy', 'medium', 'hard', 'unknown', 'easy']);
  expect(rows.every(row => row.problemExternalId === '4-A')).toBe(true);
});
it('paginates Codeforces history and unique solves past the first page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    const size = Number(params.get('count'));
    const from = Number(params.get('from'));
    return Response.json({ status: 'OK', result: url.includes('user.status')
      ? from === 1 ? Array.from({ length: size }, (_, i) => ({ ...cfRow, id: i, problem: { ...cfRow.problem, index: String(i) } })) : []
      : url.includes('user.rating') ? [] : [{ handle: 'alice' }] });
  }));
  const adapter = new CodeforcesAdapter();
  expect(await adapter.fetchSubmissions('alice')).toHaveLength(1000);
  expect((await adapter.fetchStats('alice')).totalSolved).toBe(5000);
});
it('handles Codeforces provider errors and malformed responses', async () => {
  provider({ status: 404 });
  await expect(new CodeforcesAdapter().fetchSubmissions('alice')).rejects.toThrow('404');
  expect((await new CodeforcesAdapter().sync('alice')).success).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'FAILED' })));
  await expect(new CodeforcesAdapter().fetchSubmissions('alice')).rejects.toThrow('Invalid');
  await expect(new CodeforcesAdapter().fetchStats('alice')).rejects.toThrow('not found');
});
it('keeps optional Codeforces rating failures nonfatal and counts unique accepted problems', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('user.info')
    ? { status: 'OK', result: [{ handle: 'alice' }] }
    : url.includes('user.rating') ? { status: 'FAILED' }
    : { status: 'OK', result: [cfRow, cfRow, { ...cfRow, verdict: 'WRONG_ANSWER' }] })));
  expect(await new CodeforcesAdapter().fetchStats('alice')).toMatchObject({ totalSolved: 1, totalContests: 0, rating: null });
});

it.each([ccHtml, '<div class="problems-solved"><div class="heading">Solved 18</div></div>Global Rank: 52',
  '<div class="rating-number">bad</div><div class="rating-header"><span class="highest">bad</span></div>',
  '<section class="problems-solved"><h5>nothing yet</h5></section><div class="profile-loaction-item">Global Rank: none</div>'])
('scrapes CodeChef profile fields and safe empty states', async html => {
  provider({ html });
  const adapter = new CodeChefAdapter();
  const stats = await adapter.fetchStats('alice');
  expect(stats.totalSolved).toBe(html === ccHtml ? 277 : html.includes('Solved 18') ? 18 : 0);
  expect(stats.rawData).toHaveProperty('scrapedAt');
  expect(await adapter.fetchSubmissions('alice')).toEqual([]);
});
it.each([403, 404])('fails CodeChef %i responses without fake submissions or stats', async status => {
  provider({ status });
  const result = await new CodeChefAdapter().sync('alice');
  expect(result.success).toBe(false); expect(result.submissions).toEqual([]); expect(result.stats.totalSolved).toBe(0);
});

it('preserves GitHub dashboard enrichment and token headers', async () => {
  const fetcher = provider();
  const stats = await new GitHubAdapter().fetchStats('alice');
  expect(stats.rawData).toMatchObject({ public_repos: 3, total_stars: 7, top_languages: ['TypeScript', 'Python'], followers: 4 });
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic-test-token');
});
it.each([403, 404, 418])('reports GitHub %i failures consistently', async status => {
  provider({ status });
  expect((await new GitHubAdapter().sync('alice')).success).toBe(false);
});
it('keeps GitHub repo enrichment optional', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/repos?')
    ? new Response(null, { status: 403 }) : Response.json({})));
  expect((await new GitHubAdapter().fetchStats('alice')).rawData.total_stars).toBe(0);
});

it('reports HTTP failures even when provider error bodies cannot be read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 418, text: async () => { throw new Error('body unavailable'); } })));
  await expect(new CodeChefAdapter().fetchStats('alice')).rejects.toThrow('418');
  await expect(new GitHubAdapter().fetchStats('alice')).rejects.toThrow('418');
});

it('tolerates malformed optional contest and GitHub enrichment responses', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ contestHistory: {} })));
  expect(await new LeetCodeAdapter().fetchContests('alice', {} as never)).toEqual([]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/repos?') ? new Response('{bad') : Response.json({})));
  expect((await new GitHubAdapter().fetchStats('alice')).rawData.total_stars).toBe(0);
});

it.each([429, 503, 'network'] as const)('retries %s with shared backoff', async status => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: status === 'network' ? 200 : status }))
    .mockResolvedValue(Response.json({ ok: true }));
  if (status === 'network') fetcher.mockReset().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const result = fetchWithRetry('https://synthetic.test');
  await vi.runAllTimersAsync();
  expect((await result).ok).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('stops retrying exhausted network errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  await expect(fetchWithRetry('https://synthetic.test', {}, 0)).rejects.toThrow('offline');
});

it('rejects LeetCode HTTP and GraphQL errors instead of saving empty stats', async () => {
  provider({ status: 404 });
  expect((await new LeetCodeAdapter().sync('alice')).success).toBe(false);
  provider({ lc: { errors: [{ message: 'Unavailable' }] } });
  expect((await new LeetCodeAdapter().sync('alice')).success).toBe(false);
});

it('fails fast when a provider circuit opens', async () => {
  const fetcher = provider({ status: 404 });
  const adapter = new GitHubAdapter();
  for (let i = 0; i < 5; i++) expect((await adapter.sync('missing')).success).toBe(false);
  expect((await adapter.sync('missing')).error).toContain('OPEN');
  expect(fetcher).toHaveBeenCalledTimes(5);
});
