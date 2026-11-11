// src/modules/platform-sync/adapters/types.ts — Canonical internal types
// Adapters normalize provider-specific responses into these shapes.
// Persistence consumes normalized submissions; rawData preserves dashboard compatibility.

// ---------------------------------------------------------------------------
// Normalized submission from any provider
// ---------------------------------------------------------------------------

export interface PlatformSubmission {
  /** Provider-specific unique ID (e.g., LeetCode submission ID, GH commit sha) */
  externalId: string;
  problemExternalId?: string;
  problemUrl?: string;
  category?: string;
  /** Canonical platform name */
  platform: 'leetcode' | 'github' | 'codeforces' | 'codechef';
  /** Problem/contribution title */
  title: string;
  /** Difficulty classification (normalized) */
  difficulty: 'easy' | 'medium' | 'hard' | 'unknown';
  /** Submission status */
  status: 'accepted' | 'wrong_answer' | 'time_limit' | 'runtime_error' | 'compilation_error' | 'other';
  /** When the submission was made */
  submittedAt: Date;
  /** Optional: language used */
  language?: string;
  /** Optional: runtime in ms */
  runtimeMs?: number;
  /** Optional: memory in KB */
  memoryKb?: number;
  /** Provider-specific raw data (for debugging, never used in business logic) */
  _raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Normalized profile from any provider
// ---------------------------------------------------------------------------

export interface PlatformProfile {
  platform: 'leetcode' | 'github' | 'codeforces' | 'codechef';
  username: string;
  displayName?: string;
  avatarUrl?: string;
  profileUrl: string;
  /** When this data was fetched */
  fetchedAt: Date;
}

// ---------------------------------------------------------------------------
// Normalized stats from any provider
// ---------------------------------------------------------------------------

export interface PlatformStats {
  platform: 'leetcode' | 'github' | 'codeforces' | 'codechef';
  totalSolved: number;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
  /** Codeforces/LeetCode rating (undefined for GitHub) */
  rating?: number | null;
  rank?: string | null;
  rawData?: Record<string, unknown>;
  /** Total contests participated */
  totalContests?: number;
  /** GitHub-specific: total contributions */
  totalContributions?: number;
  /** When this data was fetched */
  fetchedAt: Date;
}

// ---------------------------------------------------------------------------
// Adapter sync result
// ---------------------------------------------------------------------------

export interface AdapterSyncResult {
  success: boolean;
  submissions: PlatformSubmission[];
  stats: PlatformStats;
  profile?: PlatformProfile;
  contests?: PlatformContest[];
  /** Number of fetched submissions; persistence decides which IDs are new. */
  newCount: number;
  /** Error message if success is false */
  error?: string;
  /** Duration of the provider API call(s) */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Adapter interface — each provider implements this
// ---------------------------------------------------------------------------

export interface PlatformAdapter {
  /** Canonical platform name */
  readonly platform: 'leetcode' | 'github' | 'codeforces' | 'codechef';

  /** Fetch submissions from the provider */
  fetchSubmissions(username: string, since?: Date): Promise<PlatformSubmission[]>;

  /** Fetch aggregated stats from the provider */
  fetchStats(username: string): Promise<PlatformStats>;

  /** Fetch user profile from the provider */
  fetchProfile(username: string): Promise<PlatformProfile>;

  fetchContests?(username: string, stats: PlatformStats): Promise<PlatformContest[]>;

  /** Full sync: fetch everything and return normalized result */
  sync(username: string, since?: Date): Promise<AdapterSyncResult>;
}

export interface FetchedPlatformStats {
  username: string;
  totalSolved: number;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
  rating: number | null;
  rank: string | null;
  totalContests: number;
  rawData: Record<string, unknown>;
}


export interface PlatformContest {
  title: string;
  participatedAt: Date;
  rank: number | null;
  totalParticipants: number | null;
  ratingBefore: number | null;
  ratingAfter: number | null;
  ratingChange: number | null;
  url?: string;
}
