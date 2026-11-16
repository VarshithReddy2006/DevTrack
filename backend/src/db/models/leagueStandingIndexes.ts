// Index definitions shared by the LeagueStanding model and the leagues migration,
// so the schema and the migrated collection cannot drift apart.
export interface LeagueIndexSpec {
  key: Record<string, 1 | -1>;
  options: { name: string; unique?: boolean };
}

export const LEAGUE_STANDING_INDEXES: LeagueIndexSpec[] = [
  {
    // One row per user per week: makes cohort assignment and rollover idempotent.
    key: { weekKey: 1, userId: 1 },
    options: { name: 'uq_leaguestandings_week_user', unique: true },
  },
  {
    // Cohort lookups: size counts for late joiners, rollover, Redis rebuild.
    key: { weekKey: 1, division: 1, cohortId: 1, status: 1 },
    options: { name: 'idx_leaguestandings_cohort' },
  },
  {
    // A user's league history, newest week first.
    key: { userId: 1, weekKey: -1 },
    options: { name: 'idx_leaguestandings_user_history' },
  },
];
