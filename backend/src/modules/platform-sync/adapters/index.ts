// src/modules/platform-sync/adapters/index.ts — Adapter barrel
// Exports all platform adapters and a registry for dynamic dispatch.

export { leetcodeAdapter, LeetCodeAdapter } from './leetcode.adapter.js';
export { githubAdapter, GitHubAdapter } from './github.adapter.js';
export { codeforcesAdapter, CodeforcesAdapter } from './codeforces.adapter.js';
export { codechefAdapter, CodeChefAdapter } from './codechef.adapter.js';
export type {
  PlatformAdapter,
  PlatformSubmission,
  PlatformStats,
  PlatformProfile,
  AdapterSyncResult,
  PlatformContest,
  FetchedPlatformStats,
} from './types.js';

import { leetcodeAdapter } from './leetcode.adapter.js';
import { githubAdapter } from './github.adapter.js';
import { codeforcesAdapter } from './codeforces.adapter.js';
import { codechefAdapter } from './codechef.adapter.js';
import type { PlatformAdapter } from './types.js';

/**
 * Registry: look up adapter by platform name.
 * Throws if the platform is unsupported.
 */
export function getAdapter(platform: string): PlatformAdapter {
  switch (platform) {
    case 'leetcode':
      return leetcodeAdapter;
    case 'github':
      return githubAdapter;
    case 'codeforces':
      return codeforcesAdapter;
    case 'codechef':
      return codechefAdapter;
    default:
      throw new Error(`No adapter registered for platform: ${platform}`);
  }
}
