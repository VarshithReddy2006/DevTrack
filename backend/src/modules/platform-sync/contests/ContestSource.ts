export type ContestPlatform = 'codeforces' | 'leetcode' | 'atcoder' | 'codechef';

export type ContestPhase =
  | 'BEFORE'
  | 'CODING'
  | 'PENDING_SYSTEM_TEST'
  | 'SYSTEM_TEST'
  | 'FINISHED'
  | 'UPCOMING'
  | 'ONGOING';

export interface UpcomingContest {
  platform: ContestPlatform;
  externalId: string;
  contestName: string;
  startTime: Date;
  endTime: Date;
  durationSeconds: number;
  url: string;
  phase: ContestPhase;
  kind: 'scheduled';
  stale?: boolean;
  fetchedAt?: Date | null;
}

export interface ContestSource {
  readonly platform: ContestPlatform;
  fetchUpcoming(signal?: AbortSignal): Promise<UpcomingContest[]>;
}
