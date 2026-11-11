import { BasePlatformAdapter } from './BasePlatformAdapter.js';
import { fetchStatsData } from './codechef.data.js';

export class CodeChefAdapter extends BasePlatformAdapter {
  readonly platform = 'codechef' as const;
  protected profileUrl(username: string): string { return 'https://www.codechef.com/users/' + encodeURIComponent(username); }
  async fetchStats(username: string) {
    return { ...await fetchStatsData(username), platform: this.platform, fetchedAt: new Date() };
  }
}
export const codechefAdapter = new CodeChefAdapter();
