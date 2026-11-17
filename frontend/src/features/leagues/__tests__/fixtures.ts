import type { CohortStandings, LeagueCohortMember } from '../types';

export function makeCohort(size = 30, myRank = 12): LeagueCohortMember[] {
  return Array.from({ length: size }, (_, index) => {
    const rank = index + 1;
    return {
      rank,
      userId: `user-${rank}`,
      username: `dev${rank}`,
      displayName: `Dev Number ${rank}`,
      avatarUrl: rank % 2 === 0 ? `https://img.example/${rank}.png` : null,
      points: (size - index) * 100 + 40,
      isMe: rank === myRank,
    };
  });
}

export function makeView(overrides: Partial<CohortStandings> = {}): CohortStandings {
  const standings = overrides.standings ?? makeCohort();
  const mine = standings.find((member) => member.isMe);
  return {
    participating: true,
    weekKey: '2026-W47',
    weekStartsAt: '2026-11-16T00:00:00.000Z',
    resetsAt: '2026-11-23T00:00:00.000Z',
    secondsUntilReset: 7 * 24 * 3600,
    division: 'gold',
    cohortId: 'c1',
    cohortSize: standings.length,
    promotionSlots: Math.floor((standings.length * 20) / 100),
    demotionSlots: Math.floor((standings.length * 20) / 100),
    me: mine ? { rank: mine.rank, points: mine.points } : null,
    standings,
    ...overrides,
  };
}
