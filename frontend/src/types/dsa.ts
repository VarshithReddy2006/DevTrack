export type SubmissionStatus = 'accepted' | 'wrong';
export type Platform = 'leetcode' | 'codeforces' | 'codechef' | 'github';

export type Submission = {
  id: string;
  status: SubmissionStatus;
  problem: string;
  topic: string;
  platform: Platform;
  language: string;
  date: string;
  difficulty?: 'easy' | 'medium' | 'hard';
};

export type Topic = {
  name: string;
  progress: number;
};

export type Contest = {
  id: string;
  contestName: string;
  platform: string;
  rank: number | null;
  totalParticipants: number | null;
  problemsSolved: number;
  ratingChange: number | null;
  participatedAt: string;
};

export type DsaStat = {
  label: string;
  value: string;
  icon?: string;
};

export type PlatformOverviewItem = {
  platform: Platform;
  stat: string;
  totalSolved?: number;
  easy?: number;
  medium?: number;
  hard?: number;
  rating?: number | null;
  rank?: string | null;
};

export type DsaDifficultyCounts = Record<'easy' | 'medium' | 'hard' | 'unknown', number>;

export type DsaData = {
  solvedByDifficulty?: DsaDifficultyCounts;
  stats: DsaStat[];
  heatmap: number[];
  submissions: Submission[];
  contests: Contest[];
  topics: Topic[];
  platformOverview: PlatformOverviewItem[];
};
