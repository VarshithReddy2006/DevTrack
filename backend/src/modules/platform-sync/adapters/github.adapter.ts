import { BasePlatformAdapter } from './BasePlatformAdapter.js';
import { fetchStatsData } from './github.data.js';

export class GitHubAdapter extends BasePlatformAdapter {
  readonly platform = 'github' as const;
  protected profileUrl(username: string): string { return 'https://github.com/' + encodeURIComponent(username); }
  async fetchStats(username: string) {
    return { ...await fetchStatsData(username), platform: this.platform, fetchedAt: new Date() };
  }
}
export const githubAdapter = new GitHubAdapter();
