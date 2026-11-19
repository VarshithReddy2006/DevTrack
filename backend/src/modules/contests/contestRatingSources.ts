import { z } from 'zod';

export interface ContestResult {
  rank: number | null;
  score: number | null;
  problemsSolved: number;
  ratingBefore: number | null;
  ratingAfter: number | null;
  ratingChange: number | null;
}

export class ContestProviderRateLimit extends Error {
  constructor(readonly retryAfterMs: number) { super('Contest provider rate limited'); }
}

let lastRequestAt = 0;
async function request(url: string, init: RequestInit = {}, intervalMs = 2100): Promise<unknown> {
  const delay = Math.max(0, lastRequestAt + intervalMs - Date.now());
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  lastRequestAt = Date.now();
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (response.status === 429) {
    const header = response.headers.get('retry-after');
    const retryAfterMs = header && /^\d+(?:\.\d+)?$/.test(header)
      ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 60_000;
    await response.body?.cancel();
    throw new ContestProviderRateLimit(Number.isFinite(retryAfterMs) ? Math.max(2100, retryAfterMs) : 60_000);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Contest provider HTTP ${response.status}`);
  }
  return response.json();
}

const ratingSchema = z.object({ handle: z.string(), oldRating: z.number().finite(), newRating: z.number().finite() });
const cfResponse = z.object({ status: z.string(), comment: z.string().optional(), result: z.unknown().optional() });
async function codeforces(method: string, contestId: string): Promise<unknown> {
  const body = cfResponse.parse(await request(`https://codeforces.com/api/${method}?contestId=${encodeURIComponent(contestId)}`));
  if (body.status !== 'OK') {
    if (/call limit exceeded/i.test(body.comment ?? '')) throw new ContestProviderRateLimit(60_000);
    if (method === 'contest.ratingChanges' && /rating changes are unavailable|not rated|unrated/i.test(body.comment ?? '')) return [];
    throw new Error('Codeforces contest results unavailable');
  }
  return body.result;
}

// Regular public contest standings permit only contestId, not a handles filter.
// Fetch once per contest and index locally instead of downloading once per user.
export async function fetchCodeforcesResults(externalId: string): Promise<Map<string, ContestResult>> {
  if (!/^\d+$/.test(externalId)) throw new Error('Invalid Codeforces contest ID');
  const standings = z.object({
    contest: z.object({ id: z.number().int(), phase: z.string() }),
    rows: z.array(z.object({
      party: z.object({ participantType: z.string(), members: z.array(z.object({ handle: z.string() })) }),
      rank: z.number().int().positive(), points: z.number().finite(),
      problemResults: z.array(z.object({ points: z.number().finite() })),
    })),
  }).parse(await codeforces('contest.standings', externalId));
  if (String(standings.contest.id) !== externalId || standings.contest.phase !== 'FINISHED') throw new Error('Codeforces standings are not final');
  const ratings = z.array(ratingSchema).parse(await codeforces('contest.ratingChanges', externalId));
  const byHandle = new Map(ratings.map(row => [row.handle.toLowerCase(), row]));
  const results = new Map<string, ContestResult>();
  for (const row of standings.rows) {
    if (row.party.participantType !== 'CONTESTANT') continue;
    for (const member of row.party.members) {
      const key = member.handle.toLowerCase();
      const rating = byHandle.get(key);
      results.set(key, { rank: row.rank, score: row.points,
        problemsSolved: row.problemResults.filter(problem => problem.points > 0).length,
        ratingBefore: rating?.oldRating ?? null, ratingAfter: rating?.newRating ?? null,
        ratingChange: rating ? rating.newRating - rating.oldRating : null,
      });
    }
  }
  return results;
}

const historyRow = z.object({
  attended: z.boolean(), problemsSolved: z.number().int().nonnegative(),
  ranking: z.number().int().nonnegative().nullable(), rating: z.number().finite().nullable(),
  contest: z.object({ startTime: z.number().int().nonnegative() }),
});

export async function fetchLeetcodeResult(handle: string, startTime: Date): Promise<ContestResult | null> {
  const body = z.object({
    errors: z.array(z.unknown()).optional(),
    data: z.object({ userContestRankingHistory: z.array(historyRow).nullable() }).nullable().optional(),
  }).parse(await request('https://leetcode.com/graphql', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com' },
    body: JSON.stringify({ query: `query contestRatings($username: String!) {
      userContestRankingHistory(username: $username) { attended problemsSolved ranking rating contest { startTime } }
    }`, variables: { username: handle } }),
  }, 500));
  if (body.errors?.length || !body.data || body.data.userContestRankingHistory === null) throw new Error('LeetCode contest history unavailable');
  const history = body.data.userContestRankingHistory.filter(row => row.attended).sort((a, b) => a.contest.startTime - b.contest.startTime);
  const index = history.findIndex(row => row.contest.startTime * 1000 === startTime.getTime());
  if (index < 0) return null;
  const row = history[index];
  const ratingAfter = row.rating !== null && row.rating > 0 ? row.rating : null;
  const previous = history[index - 1]?.rating;
  // Do not invent a first-contest baseline or substitute current profile rating.
  const ratingBefore = previous != null && previous > 0 ? previous : null;
  return { rank: row.ranking && row.ranking > 0 ? row.ranking : null, score: null,
    problemsSolved: row.problemsSolved, ratingBefore, ratingAfter,
    ratingChange: ratingBefore !== null && ratingAfter !== null ? Number((ratingAfter - ratingBefore).toFixed(6)) : null,
  };
}
