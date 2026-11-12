import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusSession } from '../../../db/models/focusSession.model.js';
import { User } from '../../../db/models/user.model.js';
import { UserDailyChallenge } from '../../../db/models/userDailyChallenge.model.js';
import { CoachingService } from '../../../modules/coaching/coaching.service.js';
import { ReflectionService } from '../../../modules/coaching/reflection.service.js';
import { FocusIntelligenceService } from '../../../modules/observation/focusIntelligence.service.js';

async function createUser(timezone: string) {
  const username = timezone.toLowerCase().replace(/[^a-z]/g, '-');
  return User.create({
    clerkId: `clerk-${username}`,
    email: `${username}@example.com`,
    username,
    displayName: username,
    timezone,
  });
}

async function createFocusSession(userId: string, startedAt: string) {
  await FocusSession.create({
    userId,
    startedAt: new Date(startedAt),
    mode: 'deep_work',
    status: 'completed',
    plannedDurationMinutes: 30,
    actualDurationMinutes: 30,
    focusQualityScore: 85,
  });
}

function setNow(date: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(date));
}

describe('Coaching and focus timezones', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['Asia/Kolkata', 'streak_risk'],
    ['America/New_York', 'calm'],
    ['UTC', 'calm'],
    ['Invalid/Zone', 'calm'],
  ])('checks the streak risk hour in %s', async (timezone, expected) => {
    setNow('2026-01-15T15:00:00Z');
    const user = await createUser(timezone);

    await expect(CoachingService.detectEmotionalState(user.id)).resolves.toBe(expected);
  });

  it('uses local midnight to decide whether a user was active today', async () => {
    setNow('2026-01-15T15:00:00Z');
    const user = await createUser('Asia/Kolkata');
    await createFocusSession(user.id, '2026-01-14T18:29:59Z');
    await expect(CoachingService.detectEmotionalState(user.id)).resolves.toBe('streak_risk');

    await createFocusSession(user.id, '2026-01-14T18:30:00Z');
    await expect(CoachingService.detectEmotionalState(user.id)).resolves.toBe('calm');
  });

  it.each([
    ['Asia/Kolkata', 'Morning'],
    ['America/New_York', 'Night'],
    ['UTC', 'Night'],
    ['Invalid/Zone', 'Night'],
  ])('buckets a focus session in %s', async (timezone, expected) => {
    const user = await createUser(timezone);
    await createFocusSession(user.id, '2026-07-15T03:00:00Z');

    await expect(FocusIntelligenceService.analyzeUserFocus(user.id))
      .resolves.toMatchObject({ mostConsistentTimeOfDay: expected });
  });

  it('uses the same local weekly cutoff for sessions and challenges across a DST transition', async () => {
    setNow('2026-03-10T15:00:00Z');
    const user = await createUser('America/New_York');
    const before = '2026-03-03T04:59:59Z';
    const atCutoff = '2026-03-03T05:00:00Z';
    await createFocusSession(user.id, before);
    await createFocusSession(user.id, atCutoff);
    await UserDailyChallenge.create([
      { userId: user.id, challengeDate: '2026-03-02', completedAt: new Date(before), xpAwarded: 10 },
      { userId: user.id, challengeDate: '2026-03-03', completedAt: new Date(atCutoff), xpAwarded: 10 },
    ]);

    await expect(ReflectionService.generateWeeklyReflection(user.id))
      .resolves.toMatchObject({ totalFocusMinutes: 30, completedChallenges: 1 });
  });
});
