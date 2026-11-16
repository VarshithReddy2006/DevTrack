import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { User } from '../../../db/models/user.model.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { XpTransaction, type XpSourceType } from '../../../db/models/xpTransaction.model.js';
import { maxXpInWindow, VerificationEngine } from '../../../modules/profile/verification.engine.js';

const MINUTE = 60_000;

function verifiedProject(userId: Types.ObjectId) {
  return VerifiedProject.create({
    userId, githubRepoId: String(userId), repoFullName: 'octo/p', repoUrl: 'https://example.test/p',
    name: 'Project', verification: { status: 'verified' },
  });
}

async function makeUser() {
  const _id = new Types.ObjectId();
  return User.create({ _id, displayName: 'Velocity user', clerkId: String(_id), username: 'u' + _id, email: _id + '@example.test' });
}

let seq = 0;
async function grantXp(
  userId: Types.ObjectId,
  grants: { xp: number; minutesAgo: number; sourceType?: XpSourceType }[],
) {
  await XpTransaction.insertMany(grants.map(({ xp, minutesAgo, sourceType = 'challenge_completed' }) => ({
    userId, sourceType, sourceId: `velocity-${seq++}`, xpAwarded: xp,
    previousTotalXp: 0, newTotalXp: xp, levelBefore: 1, levelAfter: 1,
    createdAt: new Date(Date.now() - minutesAgo * MINUTE),
  })));
}

describe('maxXpInWindow', () => {
  it('returns the best sliding window, not the total', () => {
    const events = [0, 5, 9, 20, 21].map((m, i) => ({ at: m * MINUTE, xp: 100 * (i + 1) }));
    // 0..9 min holds 100+200+300, 20..21 min only 400+500.
    expect(maxXpInWindow(events, 10 * MINUTE)).toBe(900);
    expect(maxXpInWindow(events, 1 * MINUTE)).toBe(900);
    expect(maxXpInWindow(events, 60 * MINUTE)).toBe(1500);
  });

  it('includes events exactly one window apart and handles empty input', () => {
    expect(maxXpInWindow([{ at: 0, xp: 5 }, { at: 10 * MINUTE, xp: 7 }], 10 * MINUTE)).toBe(12);
    expect(maxXpInWindow([{ at: 0, xp: 5 }, { at: 10 * MINUTE + 1, xp: 7 }], 10 * MINUTE)).toBe(7);
    expect(maxXpInWindow([], 10 * MINUTE)).toBe(0);
  });
});

describe('VerificationEngine XP velocity', () => {
  it('flags more than 2000 XP inside ten minutes even for a user with verified projects', async () => {
    const user = await makeUser();
    await verifiedProject(user._id);
    await grantXp(user._id, [1, 2, 3, 4, 5].map(minutesAgo => ({ xp: 450, minutesAgo })));
    const result = await VerificationEngine.evaluateTrustScore(user._id);
    expect(result.flags).toEqual(['abnormal_xp_velocity']);
    expect(result.suspicionScore).toBeGreaterThan(70);
  });

  it('does not flag exactly 2000 XP in ten minutes or a steady normal pace', async () => {
    const burstAtLimit = await makeUser();
    await grantXp(burstAtLimit._id, [1, 2, 3, 4].map(minutesAgo => ({ xp: 500, minutesAgo })));
    // Verified project work exempts the hourly rule, which leaves the ten minute limit under test.
    await verifiedProject(burstAtLimit._id);
    const steady = await makeUser();
    // A heavy but plausible week: 300 XP an hour for 5 hours, every day.
    await grantXp(steady._id, [0, 1, 2, 3, 4].flatMap(day =>
      [0, 1, 2, 3, 4].map(hour => ({ xp: 300, minutesAgo: day * 1440 + hour * 60 + 30 }))));
    for (const { _id } of [burstAtLimit, steady]) {
      expect(await VerificationEngine.evaluateTrustScore(_id)).toMatchObject({ flags: [], suspicionScore: 0 });
    }
  });

  it('flags more than 1000 XP an hour only when the user has no verified project', async () => {
    const bare = await makeUser();
    const withProject = await makeUser();
    // 1200 XP over 50 minutes, but never more than 2000 inside ten minutes.
    const spread = [0, 10, 20, 30, 40, 50].map(minutesAgo => ({ xp: 200, minutesAgo }));
    await grantXp(bare._id, spread);
    await grantXp(withProject._id, spread);
    await verifiedProject(withProject._id);
    expect(await VerificationEngine.evaluateTrustScore(bare._id)).toMatchObject({
      flags: ['abnormal_xp_velocity'], suspicionScore: 80,
    });
    expect(await VerificationEngine.evaluateTrustScore(withProject._id)).toMatchObject({ flags: [], suspicionScore: 0 });
  });

  it('ignores bulk sync credits, admin grants and activity older than the 7 day look-back', async () => {
    const user = await makeUser();
    await grantXp(user._id, [
      { xp: 5000, minutesAgo: 1, sourceType: 'sync_completed' },
      { xp: 5000, minutesAgo: 2, sourceType: 'manual' },
      ...[0, 1, 2].map(i => ({ xp: 1000, minutesAgo: 8 * 1440 + i })),
    ]);
    expect(await VerificationEngine.evaluateTrustScore(user._id)).toMatchObject({ flags: [], suspicionScore: 0 });
  });

  it('only looks at the evaluated user', async () => {
    const gamer = await makeUser();
    const bystander = await makeUser();
    await grantXp(gamer._id, [1, 2, 3].map(minutesAgo => ({ xp: 1000, minutesAgo })));
    expect(await VerificationEngine.evaluateTrustScore(bystander._id)).toMatchObject({ flags: [], suspicionScore: 0 });
    expect((await VerificationEngine.evaluateTrustScore(gamer._id)).flags).toContain('abnormal_xp_velocity');
  });
});
