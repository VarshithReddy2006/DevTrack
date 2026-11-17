import { afterEach, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { ProfileAuditLog } from '../../../db/models/profileAuditLog.model.js';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { User } from '../../../db/models/user.model.js';
import { XpTransaction } from '../../../db/models/xpTransaction.model.js';
import { AntiGamingWorker } from '../../../modules/profile/antiGaming.worker.js';
import { getPublicProfile } from '../../../modules/profile/profile.controller.js';
import { consumerRegistry, type DomainEventEnvelope } from '../../../shared/events/index.js';

const DAY = 86_400_000;

async function makeUser() {
  const _id = new Types.ObjectId();
  return User.create({ _id, displayName: 'Audit user', clerkId: String(_id), username: 'u' + _id, email: _id + '@example.test' });
}

let seq = 0;
function grantXp(userId: Types.ObjectId, grants: { xp: number; minutesAgo: number }[]) {
  return XpTransaction.insertMany(grants.map(({ xp, minutesAgo }) => ({
    userId, sourceType: 'challenge_completed', sourceId: `audit-${seq++}`, xpAwarded: xp,
    previousTotalXp: 0, newTotalXp: xp, levelBefore: 1, levelAfter: 1,
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
  })));
}

const flaggedEvents: DomainEventEnvelope[] = [];
consumerRegistry.register('profile.flagged', {
  name: 'antiGamingTestConsumer',
  dedup: 'natural',
  handle: async event => { flaggedEvents.push(event); },
});
afterEach(() => { flaggedEvents.length = 0; });

it('flags an XP-farming profile once, logs the score change and stays quiet for normal users', async () => {
  const [gamer, normal] = await Promise.all([makeUser(), makeUser()]);
  // 2250 XP in five minutes next to a user who earned a normal 50 XP.
  await grantXp(gamer._id, [1, 2, 3, 4, 5].map(minutesAgo => ({ xp: 450, minutesAgo })));
  await grantXp(normal._id, [{ xp: 50, minutesAgo: 30 }]);

  const scheduledAt = new Date();
  await AntiGamingWorker.startAuditJob(scheduledAt);

  expect(await PublicProfile.findOne({ userId: gamer._id })).toMatchObject({
    antiGaming: { isFlagged: true, suspicionScore: 80, flags: ['abnormal_xp_velocity'] },
  });
  expect(await PublicProfile.findOne({ userId: normal._id })).toMatchObject({
    antiGaming: { isFlagged: false, suspicionScore: 0, flags: [] },
  });

  const gamerLogs = await ProfileAuditLog.find({ userId: gamer._id }).sort({ eventType: 1 }).lean();
  expect(gamerLogs.map(({ eventType }) => eventType)).toEqual(['anti_gaming_check', 'flag_raised']);
  for (const log of gamerLogs) {
    expect(log).toMatchObject({ triggeredBy: 'system', suspicionScoreBefore: null, suspicionScoreAfter: 80 });
  }
  expect((await ProfileAuditLog.find({ userId: normal._id }).lean()).map(({ eventType }) => eventType))
    .toEqual(['anti_gaming_check']);

  expect(flaggedEvents).toHaveLength(1);
  expect(flaggedEvents[0]).toMatchObject({
    type: 'profile.flagged', userId: String(gamer._id),
    payload: { suspicionScore: 80, previousSuspicionScore: null, flags: ['abnormal_xp_velocity'] },
  });

  // Same UTC day again, and the next day while the burst is still inside the look-back:
  // no second flag entry and no second event.
  await AntiGamingWorker.startAuditJob(scheduledAt);
  await AntiGamingWorker.startAuditJob(new Date(scheduledAt.getTime() + DAY));
  expect(await ProfileAuditLog.countDocuments({ userId: gamer._id, eventType: 'flag_raised' })).toBe(1);
  expect(await ProfileAuditLog.countDocuments({ userId: gamer._id, eventType: 'anti_gaming_check' })).toBe(2);
  expect(await ProfileAuditLog.findOne({ userId: gamer._id, eventType: 'anti_gaming_check' }).sort({ createdAt: -1 }))
    .toMatchObject({ suspicionScoreBefore: 80, suspicionScoreAfter: 80 });
  expect(flaggedEvents).toHaveLength(1);
});

it('raises the flag even when a profile rebuild already stored the score, and logs when it clears', async () => {
  const user = await makeUser();
  await grantXp(user._id, [1, 2, 3].map(minutesAgo => ({ xp: 1000, minutesAgo })));
  // Something else (a rebuild) already wrote the flag onto the profile before the first audit.
  await PublicProfile.create({
    userId: user._id, username: user.username, slug: user.username,
    antiGaming: { isFlagged: true, suspicionScore: 80, flags: ['abnormal_xp_velocity'] },
  });

  const scheduledAt = new Date();
  await AntiGamingWorker.startAuditJob(scheduledAt);
  expect(await ProfileAuditLog.countDocuments({ userId: user._id, eventType: 'flag_raised' })).toBe(1);
  expect(flaggedEvents).toHaveLength(1);

  await XpTransaction.deleteMany({ userId: user._id });
  await AntiGamingWorker.startAuditJob(new Date(scheduledAt.getTime() + DAY));
  expect(await PublicProfile.findOne({ userId: user._id })).toMatchObject({ antiGaming: { isFlagged: false, suspicionScore: 0 } });
  expect(await ProfileAuditLog.findOne({ userId: user._id, eventType: 'flag_cleared' })).toMatchObject({
    suspicionScoreBefore: 80, suspicionScoreAfter: 0,
  });
  expect(flaggedEvents).toHaveLength(1);
});

it('retries a user whose flag write failed without duplicating the entry or event', async () => {
  const user = await makeUser();
  await grantXp(user._id, [1, 2, 3].map(minutesAgo => ({ xp: 1000, minutesAgo })));
  const scheduledAt = new Date();

  const handler = vi.spyOn(consumerRegistry.getConsumers('profile.flagged')[0], 'handle')
    .mockRejectedValueOnce(new Error('consumer down'));
  try {
    await expect(AntiGamingWorker.startAuditJob(scheduledAt)).rejects.toThrow('1 profiles');
    // The user is not marked as audited for the day, so the next attempt picks it up again.
    expect(await ProfileAuditLog.countDocuments({ userId: user._id, eventType: 'anti_gaming_check' })).toBe(0);
    await AntiGamingWorker.startAuditJob(scheduledAt);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await ProfileAuditLog.countDocuments({ userId: user._id, eventType: 'flag_raised' })).toBe(1);
    expect(await ProfileAuditLog.countDocuments({ userId: user._id, eventType: 'anti_gaming_check' })).toBe(1);
  } finally {
    handler.mockRestore();
  }
});

it('hides badges and shows an under-review marker on the public profile while flagged', async () => {
  const [flagged, clean] = await Promise.all([makeUser(), makeUser()]);
  const achievements = [{ id: 'streak-30', name: 'Month streak', icon: 'flame', rarity: 'legendary', category: 'streak', unlockedAt: new Date() }];
  for (const [user, isFlagged] of [[flagged, true], [clean, false]] as const) {
    await PublicProfile.create({
      userId: user._id, username: user.username, slug: user.username,
      snapshot: { version: 2, achievements },
      antiGaming: { isFlagged, suspicionScore: isFlagged ? 80 : 0, flags: isFlagged ? ['abnormal_xp_velocity'] : [] },
      published: true,
      visibility: 'public',
      sections: { streak: true, dsa: true, github: true, projects: true, activity: true },
    });
  }

  const read = async (username: string) => {
    const json = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json } as unknown as Parameters<typeof getPublicProfile>[1];
    await getPublicProfile({ params: { username }, ip: '127.0.0.1' } as unknown as Parameters<typeof getPublicProfile>[0], response);
    return json.mock.lastCall?.[0].data;
  };

  const hidden = await read(flagged.username);
  expect(hidden).toMatchObject({ achievements: [], trust: { underReview: true } });
  expect(JSON.stringify(hidden)).not.toContain('abnormal_xp_velocity');
  expect(await read(clean.username)).toMatchObject({
    achievements: [{ id: 'streak-30', name: 'Month streak' }], trust: { underReview: false },
  });
});
