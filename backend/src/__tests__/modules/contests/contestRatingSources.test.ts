import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContestProviderRateLimit, fetchCodeforcesResults, fetchLeetcodeResult } from '../../../modules/contests/contestRatingSources.js';

const fetchMock = vi.fn();
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const cf = (result: unknown) => response({ status: 'OK', result });
const standings = (participantType = 'CONTESTANT') => ({ contest: { id: 123, phase: 'FINISHED' }, rows: [{
  party: { participantType, members: [{ handle: 'ALPHA' }] }, rank: 12, points: 2300,
  problemResults: [{ points: 1000 }, { points: 1300 }, { points: 0 }],
}] });
const historyRow = (startTime: number, rating: number | null, attended = true) => ({
  attended, rating, ranking: 123, problemsSolved: 3, contest: { startTime },
});

async function settle<T>(pending: Promise<T>): Promise<T> {
  const settled = pending.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await settled;
  if ('error' in result) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Codeforces contest snapshots', () => {
  it.each([45, -12, 0])('calculates rating delta %s from the provider before/after pair', async delta => {
    fetchMock.mockResolvedValueOnce(cf(standings())).mockResolvedValueOnce(cf([{ handle: 'Alpha', oldRating: 1500, newRating: 1500 + delta }]));
    expect((await settle(fetchCodeforcesResults('123'))).get('alpha')).toEqual({ rank: 12, score: 2300, problemsSolved: 2, ratingBefore: 1500, ratingAfter: 1500 + delta, ratingChange: delta });
    for (const call of fetchMock.mock.calls) {
      const url = new URL(call[0]);
      expect([...url.searchParams.keys()]).toEqual(['contestId']);
      expect(call[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    }
  });

  it('retains standings for an unrated or not-yet-published contest without inventing a delta', async () => {
    fetchMock.mockResolvedValueOnce(cf(standings())).mockResolvedValueOnce(response({ status: 'FAILED', comment: 'Rating changes are unavailable for this contest.' }));
    expect((await settle(fetchCodeforcesResults('123'))).get('alpha')).toMatchObject({ rank: 12, ratingBefore: null, ratingAfter: null, ratingChange: null });
  });

  it.each(['PRACTICE', 'VIRTUAL', 'OUT_OF_COMPETITION'])('excludes %s standings', async type => {
    fetchMock.mockResolvedValueOnce(cf(standings(type))).mockResolvedValueOnce(cf([]));
    expect((await settle(fetchCodeforcesResults('123'))).size).toBe(0);
  });

  it('rejects non-final, mismatched and malformed standings', async () => {
    fetchMock.mockResolvedValueOnce(cf({ ...standings(), contest: { id: 123, phase: 'SYSTEM_TEST' } }));
    await expect(settle(fetchCodeforcesResults('123'))).rejects.toThrow('not final');
    fetchMock.mockResolvedValueOnce(cf(standings()));
    await expect(settle(fetchCodeforcesResults('124'))).rejects.toThrow('not final');
    fetchMock.mockResolvedValueOnce(cf({ ...standings(), rows: [{ rank: 'invalid' }] }));
    await expect(settle(fetchCodeforcesResults('123'))).rejects.toThrow();
    await expect(settle(fetchCodeforcesResults('123&handles=attacker'))).rejects.toThrow('Invalid Codeforces contest ID');
  });

  it('propagates server and transport failures for worker backoff', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 503));
    await expect(settle(fetchCodeforcesResults('123'))).rejects.toThrow('HTTP 503');
    fetchMock.mockRejectedValueOnce(new Error('network offline'));
    await expect(settle(fetchCodeforcesResults('123'))).rejects.toThrow('network offline');
  });

  it('respects Retry-After seconds and Codeforces application-level throttling', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 429, { 'Retry-After': '120' }));
    await expect(settle(fetchCodeforcesResults('123'))).rejects.toMatchObject({ retryAfterMs: 120_000 });
    fetchMock.mockResolvedValueOnce(response({ status: 'FAILED', comment: 'Call limit exceeded' }));
    await expect(settle(fetchCodeforcesResults('123'))).rejects.toBeInstanceOf(ContestProviderRateLimit);
  });
});

describe('LeetCode per-contest history', () => {
  it.each([45.125, -12.75, 0])('derives fractional delta %s from chronological attended contests', async delta => {
    fetchMock.mockResolvedValueOnce(response({ data: { userContestRankingHistory: [
      historyRow(200, 1500 + delta), historyRow(300, 1800), historyRow(100, 1500), historyRow(150, 9999, false),
    ] } }));
    expect(await settle(fetchLeetcodeResult('Alpha', new Date(200_000)))).toEqual({ rank: 123, score: null, problemsSolved: 3, ratingBefore: 1500, ratingAfter: 1500 + delta, ratingChange: delta });
    expect(fetchMock.mock.calls[0][0]).toBe('https://leetcode.com/graphql');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toEqual({ username: 'Alpha' });
  });

  it('does not invent a rating baseline for the first attended contest', async () => {
    fetchMock.mockResolvedValueOnce(response({ data: { userContestRankingHistory: [historyRow(100, 1532.123)] } }));
    expect(await settle(fetchLeetcodeResult('Alpha', new Date(100_000)))).toMatchObject({ ratingBefore: null, ratingAfter: 1532.123, ratingChange: null });
  });

  it('uses null for pending/unrated ratings and unavailable scores', async () => {
    fetchMock.mockResolvedValueOnce(response({ data: { userContestRankingHistory: [historyRow(100, 1500), historyRow(200, 0)] } }));
    expect(await settle(fetchLeetcodeResult('Alpha', new Date(200_000)))).toMatchObject({ ratingAfter: null, ratingChange: null, score: null });
  });

  it('skips nonparticipants and matches by exact contest start rather than title', async () => {
    fetchMock.mockResolvedValueOnce(response({ data: { userContestRankingHistory: [historyRow(100, 1500, false)] } }));
    expect(await settle(fetchLeetcodeResult('Alpha', new Date(100_000)))).toBeNull();
    fetchMock.mockResolvedValueOnce(response({ data: { userContestRankingHistory: [historyRow(100, 1500)] } }));
    expect(await settle(fetchLeetcodeResult('Alpha', new Date(101_000)))).toBeNull();
  });

  it.each([
    { data: { userContestRankingHistory: null } },
    { errors: [{ message: 'That user does not exist.' }], data: null },
    { errors: [{ message: 'user not found' }], data: null },
  ])('returns null for unranked or non-existent LeetCode profiles case %#', async body => {
    fetchMock.mockResolvedValueOnce(response(body));
    expect(await settle(fetchLeetcodeResult('Alpha', new Date(100_000)))).toBeNull();
  });

  it.each([
    { errors: [{ message: 'upstream failed' }], data: null },
    { data: { userContestRankingHistory: [{ ...historyRow(100, 1500), problemsSolved: 'invalid' }] } },
  ])('does not persist malformed or unavailable GraphQL history case %#', async body => {
    fetchMock.mockResolvedValueOnce(response(body));
    await expect(settle(fetchLeetcodeResult('Alpha', new Date(100_000)))).rejects.toThrow();
  });

  it('parses HTTP-date Retry-After headers without an immediate retry loop', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 429, { 'Retry-After': new Date(Date.now() + 120_000).toUTCString() }));
    await expect(settle(fetchLeetcodeResult('Alpha', new Date(100_000)))).rejects.toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
