import { logger } from '../../../shared/logger.js';
import { circuitBreakers } from '../../../shared/circuit-breaker/circuitBreaker.js';
import type { PlatformAdapter, PlatformSubmission, PlatformStats, PlatformProfile, AdapterSyncResult, PlatformContest } from './types.js';

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly platform: PlatformAdapter['platform'];
  abstract fetchStats(username: string): Promise<PlatformStats>;
  async fetchSubmissions(_username: string, _since?: Date): Promise<PlatformSubmission[]> { return []; }
  async fetchContests(_username: string, _stats: PlatformStats): Promise<PlatformContest[]> { return []; }
  async fetchProfile(username: string): Promise<PlatformProfile> {
    return { platform: this.platform, username, profileUrl: this.profileUrl(username), fetchedAt: new Date() };
  }
  protected abstract profileUrl(username: string): string;

  async sync(username: string, since?: Date): Promise<AdapterSyncResult> {
    const start = Date.now();
    try {
      return await circuitBreakers[this.platform].execute(async () => {
        const stats = await this.fetchStats(username);
        const [submissions, contests, profile] = await Promise.all([
          this.fetchSubmissions(username, since), this.fetchContests(username, stats), this.fetchProfile(username),
        ]);
        return { success: true, stats, submissions, contests, profile, newCount: submissions.length, durationMs: Date.now() - start };
      });
    } catch (error) {
      logger.warn(`[${this.platform}-adapter] Sync failed`, { error });
      return { success: false, submissions: [], contests: [], stats: this.emptyStats(), newCount: 0,
        error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - start };
    }
  }
  protected emptyStats(): PlatformStats {
    return { platform: this.platform, totalSolved: 0, easySolved: 0, mediumSolved: 0, hardSolved: 0, fetchedAt: new Date() };
  }
}
