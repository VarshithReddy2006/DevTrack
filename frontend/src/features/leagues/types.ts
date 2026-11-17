// Shapes returned by GET /leagues/current (backend: modules/leagues, LeagueStandingsView).

export const LEAGUE_DIVISIONS = [
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'master',
  'grandmaster',
] as const;

export type LeagueDivision = (typeof LEAGUE_DIVISIONS)[number];

export interface LeagueCohortMember {
  rank: number;
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  points: number;
  isMe: boolean;
}

export interface CohortStandings {
  participating: boolean;
  weekKey: string;
  weekStartsAt: string;
  resetsAt: string;
  secondsUntilReset: number;
  division: LeagueDivision | null;
  cohortId: string | null;
  cohortSize: number;
  /** Top N ranks move up at the weekly rollover. */
  promotionSlots: number;
  /** Bottom N ranks move down at the weekly rollover. */
  demotionSlots: number;
  me: { rank: number; points: number } | null;
  standings: LeagueCohortMember[];
}

export type LeagueZone = 'promotion' | 'safe' | 'demotion';

/** userId -> rank from an earlier look at the same cohort. */
export type RankSnapshot = Record<string, number>;
