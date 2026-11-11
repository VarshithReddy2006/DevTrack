import { BasePlatformAdapter } from './BasePlatformAdapter.js';
import { fetchStatsData } from './codeforces.data.js';
import { fetchWithRetry } from './http.js';
import type { PlatformSubmission, PlatformContest, PlatformStats } from './types.js';

export class CodeforcesAdapter extends BasePlatformAdapter {
  readonly platform = 'codeforces' as const;
  protected profileUrl(username: string): string { return `https://codeforces.com/profile/${encodeURIComponent(username)}`; }
  async fetchStats(username: string) {
    return { ...await fetchStatsData(username), platform: this.platform, fetchedAt: new Date() };
  }
  async fetchSubmissions(username: string, since?: Date): Promise<PlatformSubmission[]> {
    const cutoff = since ? new Date(since) : new Date();
    if (!since) { cutoff.setDate(cutoff.getDate() - 364); cutoff.setHours(0, 0, 0, 0); }
    const submissions: PlatformSubmission[] = [];
    for (let from = 1; ; from += 1000) {
      const response = await fetchWithRetry(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(username)}&from=${from}&count=1000`);
      if (!response.ok) throw new Error(`Codeforces submissions API error (${response.status})`);
      const data = await response.json() as { status: string; result?: any[] };
      if (data.status !== 'OK' || !Array.isArray(data.result)) throw new Error('Invalid Codeforces submissions response');
      let reachedCutoff = false;
      for (const row of data.result) {
        const submittedAt = new Date(Number(row.creationTimeSeconds) * 1000);
        if (!Number.isFinite(submittedAt.getTime())) continue;
        if (submittedAt < cutoff) { reachedCutoff = true; break; }
        if (row.id == null || !row.verdict || !row.problem) continue;
        const problem = row.problem;
        const problemExternalId = `${problem.contestId ?? 'na'}-${problem.index ?? 'na'}`;
        const status = row.verdict === 'OK' ? 'accepted' : row.verdict === 'TIME_LIMIT_EXCEEDED' ? 'time_limit'
          : row.verdict === 'RUNTIME_ERROR' ? 'runtime_error' : row.verdict === 'COMPILATION_ERROR' ? 'compilation_error' : 'wrong_answer';
        submissions.push({ externalId: String(row.id), problemExternalId,
          problemUrl: problem.contestId ? `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}` : 'https://codeforces.com',
          category: 'Competitive', platform: this.platform, title: problem.name ?? 'Unknown',
          difficulty: !problem.rating ? 'unknown' : problem.rating <= 1200 ? 'easy' : problem.rating <= 1800 ? 'medium' : 'hard',
          status, submittedAt, language: row.programmingLanguage ?? row.language ?? 'unknown' });
      }
      if (reachedCutoff || data.result.length < 1000) return submissions;
    }
  }
  async fetchContests(_username: string, stats: PlatformStats): Promise<PlatformContest[]> {
    const rows = (stats.rawData?.ratingHistory ?? []) as Array<{ contestId: number; contestName: string;
      ratingUpdateTimeSeconds: number; rank: number; oldRating: number; newRating: number }>;
    return rows.map(contest => ({ title: contest.contestName, participatedAt: new Date(contest.ratingUpdateTimeSeconds * 1000),
      rank: contest.rank, totalParticipants: null, ratingBefore: contest.oldRating, ratingAfter: contest.newRating,
      ratingChange: contest.newRating - contest.oldRating, url: `https://codeforces.com/contest/${contest.contestId}` }));
  }
}
export const codeforcesAdapter = new CodeforcesAdapter();
