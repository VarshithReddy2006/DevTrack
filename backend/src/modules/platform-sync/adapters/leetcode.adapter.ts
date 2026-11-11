import { BasePlatformAdapter } from './BasePlatformAdapter.js';
import { fetchStatsData, fetchLeetCodeGraphQL } from './leetcode.data.js';
import { fetchWithRetry } from './http.js';
import { logger } from '../../../shared/logger.js';
import type { PlatformSubmission, PlatformContest, PlatformStats } from './types.js';

export class LeetCodeAdapter extends BasePlatformAdapter {
  readonly platform = 'leetcode' as const;
  protected profileUrl(username: string): string { return `https://leetcode.com/u/${encodeURIComponent(username)}/`; }
  async fetchStats(username: string) {
    return { ...await fetchStatsData(username), platform: this.platform, fetchedAt: new Date() };
  }
  async fetchSubmissions(username: string, since?: Date): Promise<PlatformSubmission[]> {
    const response = await fetchLeetCodeGraphQL(`query recentAcSubmissions($username: String!, $limit: Int!) {
      recentAcSubmissionList(username: $username, limit: $limit) { id title titleSlug timestamp }
    }`, { username, limit: 500 });
    const rows = response.data?.recentAcSubmissionList;
    if (!Array.isArray(rows)) throw new Error('Invalid LeetCode submissions response');
    return rows.flatMap((row): PlatformSubmission[] => {
      const submittedAt = new Date(Number(row.timestamp) * 1000);
      if (!row.title || !row.titleSlug || !row.timestamp || !Number.isFinite(submittedAt.getTime()) ||
          (since && submittedAt < since)) return [];
      return [{
        // Preserve historical provider IDs; a composite fallback distinguishes
        // attempts on the same problem when the public response omits its ID.
        externalId: row.id != null && String(row.id) !== '' ? String(row.id) : `${row.titleSlug}:${row.timestamp}`,
        problemExternalId: row.titleSlug, problemUrl: `https://leetcode.com/problems/${row.titleSlug}`,
        category: 'Data Structures & Algorithms', platform: this.platform, title: row.title,
        difficulty: 'unknown', status: 'accepted', submittedAt, language: 'unknown',
      }];
    });
  }
  async fetchContests(username: string, _stats: PlatformStats): Promise<PlatformContest[]> {
    try {
      const response = await fetchWithRetry(`https://alfa-leetcode-api.onrender.com/${encodeURIComponent(username)}/contest`);
      if (!response.ok) return [];
      const data = await response.json() as { contestHistory?: Array<{ title: string; startTime: number; participantCount?: number }> };
      return (data.contestHistory ?? []).flatMap(contest => {
        const participatedAt = new Date(contest.startTime * 1000);
        return contest.title && Number.isFinite(participatedAt.getTime()) ? [{ title: contest.title, participatedAt,
          totalParticipants: contest.participantCount ?? null, rank: null, ratingBefore: null, ratingAfter: null, ratingChange: null }] : [];
      });
    } catch (error) {
      logger.warn('[leetcode-adapter] Optional contest history unavailable', { error });
      return [];
    }
  }
}
export const leetcodeAdapter = new LeetCodeAdapter();
