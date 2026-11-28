import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusSession } from '../../../db/models/focusSession.model.js';
import { User } from '../../../db/models/user.model.js';
import { CoachingService } from '../../../modules/coaching/coaching.service.js';

const NOW = new Date('2026-03-20T12:00:00Z');
const HOUR = 3_600_000;
const ABANDONED_INSIGHT = "You've abandoned a few sessions lately. Try shorter intervals to rebuild momentum.";

async function createUser() {
  return User.create({
    clerkId: 'clerk-windows',
    email: 'windows@example.com',
    username: 'windows',
    displayName: 'windows',
    timezone: 'UTC',
  });
}

async function createSessions(userId: string, count: number, hoursAgo: number, status: 'completed' | 'abandoned') {
  await FocusSession.create(
    Array.from({ length: count }, (_, i) => ({
      userId,
      startedAt: new Date(NOW.getTime() - (hoursAgo + i) * HOUR),
      mode: 'deep_work',
      status,
      plannedDurationMinutes: 30,
      actualDurationMinutes: 30,
      focusQualityScore: status === 'completed' ? 70 : 0,
    })),
  );
}

describe('Coaching activity windows', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([FocusSession.deleteMany({}), User.deleteMany({})]);
  });

  function freezeNow() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  }

  it('ignores abandoned sessions older than 14 days', async () => {
    freezeNow();
    const user = await createUser();
    await createSessions(user.id, 8, 31 * 24, 'abandoned');
    await createSessions(user.id, 2, 1, 'completed');

    const insights = await CoachingService.generateCoachingInsights(user.id);

    expect(insights).not.toContain(ABANDONED_INSIGHT);
  });

  it('still flags recent abandoned sessions', async () => {
    freezeNow();
    const user = await createUser();
    await createSessions(user.id, 6, 3 * 24, 'abandoned');
    await createSessions(user.id, 2, 1, 'completed');

    const insights = await CoachingService.generateCoachingInsights(user.id);

    expect(insights).toContain(ABANDONED_INSIGHT);
  });

  it('does not report burnout from sessions outside the last 48 hours', async () => {
    freezeNow();
    const user = await createUser();
    await createSessions(user.id, 5, 10 * 24, 'abandoned');
    await createSessions(user.id, 1, 1, 'completed');

    await expect(CoachingService.detectEmotionalState(user.id)).resolves.toBe('calm');
  });

  it('reports burnout from sessions inside the last 48 hours', async () => {
    freezeNow();
    const user = await createUser();
    await createSessions(user.id, 3, 2, 'abandoned');

    await expect(CoachingService.detectEmotionalState(user.id)).resolves.toBe('burnout_risk');
  });
});
