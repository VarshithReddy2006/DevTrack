import express, { Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityEvent } from '../../../db/models/activityEvent.model.js';
import { AntiGamingDecision } from '../../../db/models/antiGamingDecision.model.js';
import { DsaProblem } from '../../../db/models/dsaProblem.model.js';
import { PlatformStats } from '../../../db/models/platformStats.model.js';
import { ProfileAuditLog } from '../../../db/models/profileAuditLog.model.js';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { User } from '../../../db/models/user.model.js';
import { UserAnalytics } from '../../../db/models/userAnalytics.model.js';
import { UserXp } from '../../../db/models/userXp.model.js';
import { XpTransaction } from '../../../db/models/xpTransaction.model.js';
import { errorHandler } from '../../../middleware/error.js';
import { opsRoutes } from '../../../modules/ops/ops.routes.js';
import { AntiGamingWorker } from '../../../modules/profile/antiGaming.worker.js';
import { applyAntiGamingReview } from '../../../modules/profile/antiGamingReview.js';
import { PublicProfileService } from '../../../modules/profile/publicProfile.service.js';
import { mapToPublicProfileDTO } from '../../../modules/profile/profile.dto.js';
import { mountApiRoutes } from '../../../routes/mount.js';
import { appendChainedAuditEvent, auditRowsFor, decryptChainedAuditEvent, verifyStoredAuditChain } from '../../../modules/audit/auditLedger.service.js';
import { executeAccountErasure } from '../../../modules/privacy/accountErasure.worker.js';
import { consumerRegistry, type DomainEventEnvelope } from '../../../shared/events/index.js';

const redis = vi.hoisted(() => ({ status: 'ready', eval: vi.fn(async () => 0), get: vi.fn(async () => null), set: vi.fn(async () => 'OK') }));
vi.mock('@clerk/backend', () => ({ verifyToken: async (token: string) => ({ sub: token }) }));
vi.mock('../../../shared/redis/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../shared/redis/client.js')>(),
  isRedisConfigured: () => true,
  getRedisClient: () => redis,
}));

const DAY = 86_400_000;
const MINUTE = 60_000;

const flaggedEvents: DomainEventEnvelope[] = [];
consumerRegistry.register('profile.flagged', {
  name: 'adminAuditTestConsumer',
  dedup: 'natural',
  handle: async event => { flaggedEvents.push(event); },
});

let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const routes = Router();
  routes.use('/ops', opsRoutes);
  mountApiRoutes(app, routes);
  app.use(errorHandler);
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1');
    listener.once('error', reject);
    listener.once('listening', () => resolve(listener));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_anti_gaming');
  redis.eval.mockClear();
  flaggedEvents.length = 0;
});
afterEach(() => { vi.unstubAllEnvs(); });

let seq = 0;
async function makeUser(role = 'user', joinedDaysAgo = 400) {
  const _id = new Types.ObjectId();
  const doc = { _id, clerkId: `clerk-${_id}`, email: `${_id}@example.test`, username: `u${_id}`, displayName: 'Review user', role };
  const joinedAt = new Date(Date.now() - joinedDaysAgo * DAY);
  // Ops-only roles come from Clerk sync and are not in the User schema enum, so write them raw.
  if (role === 'user' || role === 'admin') {
    await User.create(doc);
    // joinedAt is the createdAt timestamp, so backdate it without touching lastActiveAt.
    await User.updateOne({ _id }, { $set: { joinedAt } }, { timestamps: false });
  } else {
    await User.collection.insertOne({ ...doc, joinedAt, lastActiveAt: new Date() });
  }
  return doc;
}

function grantXp(userId: Types.ObjectId, grants: { xp: number; minutesAgo: number; sourceType?: string }[]) {
  return XpTransaction.insertMany(grants.map(({ xp, minutesAgo, sourceType = 'challenge_completed' }) => ({
    userId, sourceType, sourceId: `review-${seq++}`, xpAwarded: xp,
    previousTotalXp: 0, newTotalXp: xp, levelBefore: 1, levelAfter: 1,
    createdAt: new Date(Date.now() - minutesAgo * MINUTE),
  })));
}

const badges = [
  { id: 'streak-30', name: 'Month streak', icon: 'flame', rarity: 'legendary', category: 'streak', unlockedAt: new Date() },
  { id: 'problems-100', name: 'Centurion', icon: 'trophy', rarity: 'epic', category: 'problems', unlockedAt: new Date() },
];

async function seedProfile(user: { _id: Types.ObjectId; username: string }, antiGaming: Record<string, unknown>) {
  return PublicProfile.create({
    userId: user._id, username: user.username, slug: user.username,
    snapshot: { version: 2, achievements: badges },
    published: true, visibility: 'public',
    sections: { streak: true, dsa: true, github: true, projects: true, activity: true },
    antiGaming: { isFlagged: false, suspicionScore: 0, flags: [], ...antiGaming },
  });
}

/** An XP farmer the real worker flags: 2250 XP inside five minutes. */
async function flaggedFarmer() {
  const user = await makeUser();
  await grantXp(user._id, [1, 2, 3, 4, 5].map(minutesAgo => ({ xp: 450, minutesAgo })));
  await AntiGamingWorker.startAuditJob(new Date());
  expect(await PublicProfile.findOne({ userId: user._id }).lean()).toMatchObject({
    antiGaming: { isFlagged: true, suspicionScore: 80, flags: ['abnormal_xp_velocity'] },
  });
  return user;
}

function call(path: string, token?: string, body?: unknown) {
  return fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}
/** The decision's ledger row: found by subject hash, with its details decrypted. */
async function decisionEntry(userId: Types.ObjectId, eventType: string) {
  const row = await ProfileAuditLog.findOne({ ...await auditRowsFor(userId), eventType }).lean();
  expect(row).toMatchObject({ userId: null, details: { encrypted: true } });
  return { ...row!, details: await decryptChainedAuditEvent(row!, userId) };
}
const action = (userId: Types.ObjectId, token: string, body: unknown) => call(`/api/v2/ops/anti-gaming/${userId}/action`, token, body);

describe('GET /api/v2/ops/anti-gaming/flagged', () => {
  it('pages open flags by suspicion score with recent audit history', async () => {
    const auditor = await makeUser('readonly_auditor');
    const [high, mid, low, clean, confirmed] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser(), makeUser()]);
    await seedProfile(high, { isFlagged: true, suspicionScore: 160, flags: ['impossible_solve_velocity', 'abnormal_xp_velocity'] });
    await seedProfile(mid, { isFlagged: true, suspicionScore: 120, flags: ['abnormal_xp_velocity', 'suspicious_difficulty_ratio'] });
    await seedProfile(low, { isFlagged: true, suspicionScore: 80, flags: ['abnormal_xp_velocity'] });
    await seedProfile(clean, {});
    await seedProfile(confirmed, {
      isFlagged: true, suspicionScore: 200, flags: ['abnormal_xp_velocity'],
      review: { status: 'confirmed_gaming', flags: ['abnormal_xp_velocity'], note: 'bot', decidedBy: auditor._id, decidedAt: new Date(), decisionId: new Types.ObjectId() },
    });
    await ProfileAuditLog.create([
      { userId: high._id, eventType: 'flag_raised', triggeredBy: 'system', details: {}, suspicionScoreBefore: 0, suspicionScoreAfter: 160 },
      { userId: high._id, eventType: 'visibility_changed', triggeredBy: 'user', details: {} },
    ]);

    const first = await call('/api/v2/ops/anti-gaming/flagged?pageSize=2', auditor.clerkId);
    expect(first.status).toBe(200);
    const page1 = await first.json();
    expect(page1.data.map((row: { userId: string }) => row.userId)).toEqual([String(high._id), String(mid._id)]);
    expect(page1.pagination).toMatchObject({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2, hasNextPage: true });
    expect(page1.data[0]).toMatchObject({
      username: high.username, suspicionScore: 160, isFlagged: true, review: null,
      flags: ['impossible_solve_velocity', 'abnormal_xp_velocity'],
    });
    // Only anti-gaming entries make it into the history.
    expect(page1.data[0].history).toEqual([expect.objectContaining({ eventType: 'flag_raised', suspicionScoreAfter: 160 })]);

    const page2 = await (await call('/api/v2/ops/anti-gaming/flagged?pageSize=2&page=2', auditor.clerkId)).json();
    expect(page2.data.map((row: { userId: string }) => row.userId)).toEqual([String(low._id)]);

    const done = await (await call('/api/v2/ops/anti-gaming/flagged?state=confirmed', auditor.clerkId)).json();
    expect(done.data).toHaveLength(1);
    expect(done.data[0]).toMatchObject({ userId: String(confirmed._id), review: { status: 'confirmed_gaming', note: 'bot' } });

    expect((await call('/api/v2/ops/anti-gaming/flagged?state=everything', auditor.clerkId)).status).toBe(400);
  });
});

describe('GET /api/v2/ops/anti-gaming/:userId/breakdown', () => {
  it('returns the evidence behind the score', async () => {
    const auditor = await makeUser('trust_operator');
    const user = await makeUser('user', 2);
    await seedProfile(user, { isFlagged: true, suspicionScore: 160, flags: ['impossible_solve_velocity', 'abnormal_xp_velocity'] });
    const now = Date.now();
    // Five hard problems inside three minutes, plus an older easy one.
    await DsaProblem.insertMany([
      ...[0, 1, 2, 2.5, 3].map((minute, i) => ({
        userId: user._id, externalId: `hard-${i}`, title: `Hard ${i}`, platform: 'leetcode', difficulty: 'hard',
        url: `https://leetcode.com/problems/hard-${i}`, category: 'graphs', status: 'solved', solvedAt: new Date(now - (10 - minute) * MINUTE),
      })),
      { userId: user._id, externalId: 'easy-0', title: 'Easy 0', platform: 'leetcode', difficulty: 'easy',
        url: 'https://leetcode.com/problems/easy-0', category: 'arrays', status: 'solved', solvedAt: new Date(now - 3 * DAY) },
    ]);
    await grantXp(user._id, [
      ...[1, 2, 3, 4, 5].map(minutesAgo => ({ xp: 450, minutesAgo })),
      { xp: 5000, minutesAgo: 30, sourceType: 'sync_completed' },
    ]);
    await PlatformStats.create([
      { userId: user._id, platformName: 'leetcode', username: 'lc', totalSolved: 620, hardSolved: 510 },
      { userId: user._id, platformName: 'github', username: 'gh', rawData: { total_commits: 1500, public_repos: 1 } },
    ]);
    // Three commits at 03:xx UTC and one in the afternoon, two days ago.
    const twoDaysAgo = new Date(now - 2 * DAY);
    const dayStart = Date.UTC(twoDaysAgo.getUTCFullYear(), twoDaysAgo.getUTCMonth(), twoDaysAgo.getUTCDate());
    await ActivityEvent.insertMany([3, 3, 3, 15].map((hour, i) => ({
      userId: user._id, type: 'commit_pushed', title: `commit ${i}`, platform: 'github',
      occurredAt: new Date(dayStart + hour * 3_600_000 + i * MINUTE),
    })));
    await ProfileAuditLog.create([
      { userId: user._id, eventType: 'flag_raised', triggeredBy: 'system', details: { flags: ['abnormal_xp_velocity'] }, suspicionScoreAfter: 160 },
      { userId: user._id, eventType: 'dossier_downloaded', triggeredBy: 'user', details: { ip: '203.0.113.9' } },
    ]);

    const response = await call(`/api/v2/ops/anti-gaming/${user._id}/breakdown`, auditor.clerkId);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.profile).toMatchObject({ userId: String(user._id), suspicionScore: 160, isFlagged: true });
    expect(data.signals).toMatchObject({
      accountAgeDays: 2,
      leetcode: { totalSolved: 620, hardSolved: 510 },
      github: { totalCommits: 1500, publicRepos: 1 },
    });
    expect(data.solveVelocity.maxHardIn10Minutes).toBe(5);
    expect(data.solveVelocity.recent).toHaveLength(6);
    expect(data.solveVelocity.daily.reduce((sum: number, day: { hard: number }) => sum + day.hard, 0)).toBe(5);
    // Sync credits are excluded from the velocity peaks, exactly like the engine does.
    expect(data.xpVelocity).toMatchObject({ countedXp: 2250, peak10Minutes: 2250, limits: { per10Minutes: 2000, per60Minutes: 1000 } });
    expect(data.commits.byHourUtc).toHaveLength(24);
    expect(data.commits.byHourUtc.reduce((a: number, b: number) => a + b, 0)).toBe(4);
    expect(data.commits.byHourUtc[3]).toBe(3);
    expect(data.commits.byHourUtc[15]).toBe(1);
    expect(data.timeline).toEqual([expect.objectContaining({ eventType: 'flag_raised' })]);
    expect(JSON.stringify(data)).not.toContain('203.0.113.9');
    expect(data.decisions).toEqual([]);

    expect((await call(`/api/v2/ops/anti-gaming/${new Types.ObjectId()}/breakdown`, auditor.clerkId)).status).toBe(404);
    expect((await call('/api/v2/ops/anti-gaming/not-an-id/breakdown', auditor.clerkId)).status).toBe(400);
  });
});

describe('POST /api/v2/ops/anti-gaming/:userId/action', () => {
  it('pardons a flag, restores the public profile and keeps it through the next sweeps', async () => {
    const admin = await makeUser('admin');
    const user = await flaggedFarmer();
    await PublicProfile.updateOne({ userId: user._id }, { $set: { 'snapshot.achievements': badges, published: true, visibility: 'public',
      sections: { streak: true, dsa: true, github: true, projects: true, activity: true } } });
    expect(flaggedEvents).toHaveLength(1);

    const response = await action(user._id, admin.clerkId, { action: 'pardon', note: 'Hackathon weekend, checked the commits' });
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toMatchObject({ action: 'pardon', review: { status: 'pardoned', flags: ['abnormal_xp_velocity'] }, xp: null });
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 2, expect.any(String), expect.any(String), `user:${String(user._id)}`);

    const profile = await PublicProfile.findOne({ userId: user._id });
    expect(profile).toMatchObject({ antiGaming: { isFlagged: false, suspicionScore: 80, review: { status: 'pardoned', note: 'Hackathon weekend, checked the commits' } } });
    expect(mapToPublicProfileDTO(profile!)).toMatchObject({ trust: { underReview: false }, achievements: [{ id: 'streak-30' }, { id: 'problems-100' }] });

    const audit = await decisionEntry(user._id, 'anti_gaming_pardoned');
    expect(audit).toMatchObject({
      triggeredBy: 'admin', suspicionScoreBefore: 80,
      details: { note: 'Hackathon weekend, checked the commits', actor: { id: String(admin._id), role: 'admin' }, isFlagged: false },
    });
    expect(await AntiGamingDecision.findById(data.decisionId).lean()).toMatchObject({
      action: 'pardon', userId: user._id, flags: ['abnormal_xp_velocity'], auditLogId: audit._id, actor: { userId: admin._id },
    });

    // The same burst is still inside the look-back: the next sweeps and a rebuild must not undo the pardon.
    await AntiGamingWorker.startAuditJob(new Date(Date.now() + DAY));
    await PublicProfileService.computeProfile(user._id);
    expect(await PublicProfile.findOne({ userId: user._id }).lean()).toMatchObject({
      antiGaming: { isFlagged: false, suspicionScore: 80, review: { status: 'pardoned' } },
    });
    expect(await ProfileAuditLog.countDocuments({ userId: user._id, eventType: { $in: ['flag_raised', 'flag_cleared'] } })).toBe(1);
    expect(flaggedEvents).toHaveLength(1);

    // New evidence the pardon did not cover flags the profile again, with an audit entry and event.
    await PlatformStats.create({ userId: user._id, platformName: 'leetcode', username: 'lc', totalSolved: 100, hardSolved: 90 });
    await AntiGamingWorker.startAuditJob(new Date(Date.now() + 2 * DAY));
    expect(await PublicProfile.findOne({ userId: user._id }).lean()).toMatchObject({
      antiGaming: { isFlagged: true, flags: ['suspicious_difficulty_ratio', 'abnormal_xp_velocity'] },
    });
    expect(await ProfileAuditLog.countDocuments({ userId: user._id, eventType: 'flag_raised' })).toBe(2);
    expect(flaggedEvents).toHaveLength(2);
  });

  it('ends a pardon once a clean audit comes back, so the next episode is reviewed again', async () => {
    const admin = await makeUser('admin');
    const user = await flaggedFarmer();
    expect((await action(user._id, admin.clerkId, { action: 'pardon', note: 'ok' })).status).toBe(200);

    await XpTransaction.deleteMany({ userId: user._id });
    await AntiGamingWorker.startAuditJob(new Date(Date.now() + DAY));
    expect(await PublicProfile.findOne({ userId: user._id }).lean()).toMatchObject({ antiGaming: { isFlagged: false, review: null } });

    await grantXp(user._id, [1, 2, 3].map(minutesAgo => ({ xp: 1000, minutesAgo })));
    await AntiGamingWorker.startAuditJob(new Date(Date.now() + 2 * DAY));
    expect(await PublicProfile.findOne({ userId: user._id }).lean()).toMatchObject({ antiGaming: { isFlagged: true } });
    expect(flaggedEvents).toHaveLength(2);
  });

  it('penalizes: takes back the flagged XP, removes badges and keeps the profile flagged', async () => {
    const admin = await makeUser('admin');
    const user = await flaggedFarmer();
    // 2250 farmed XP from the helper, a legitimate admin grant and XP from long before the flag.
    await grantXp(user._id, [{ xp: 500, minutesAgo: 60, sourceType: 'manual' }, { xp: 300, minutesAgo: 30 * 24 * 60 }]);
    await UserXp.updateOne({ userId: user._id }, { $set: { totalXp: 3050, currentLevel: 8, xpToNextLevel: 100 } }, { upsert: true });
    // The dashboard rebuild during the sweep already created this document.
    await UserAnalytics.updateOne({ userId: user._id }, { $set: { totalXp: 3050, currentLevel: 8 } }, { upsert: true });
    await PublicProfile.updateOne({ userId: user._id }, { $set: { 'snapshot.achievements': badges } });

    const response = await action(user._id, admin.clerkId, { action: 'penalize', note: 'Scripted challenge submissions' });
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toMatchObject({
      action: 'penalize',
      review: { status: 'confirmed_gaming' },
      xp: { revoked: 2250, transactions: 5, totalBefore: 3050, totalAfter: 800, levelBefore: 8, levelAfter: 4 },
      badgesRemoved: ['streak-30', 'problems-100'],
    });

    expect(await UserXp.findOne({ userId: user._id }).lean()).toMatchObject({ totalXp: 800, currentLevel: 4, xpToNextLevel: 50 });
    expect(await UserAnalytics.findOne({ userId: user._id }).lean()).toMatchObject({ totalXp: 800, currentLevel: 4 });
    const profile = await PublicProfile.findOne({ userId: user._id });
    expect(profile).toMatchObject({ antiGaming: { isFlagged: true, review: { status: 'confirmed_gaming' } }, snapshot: { achievements: [] } });
    expect(mapToPublicProfileDTO(profile!)).toMatchObject({ trust: { underReview: true }, achievements: [] });
    // The XP ledger itself is immutable and stays as it was.
    expect(await XpTransaction.countDocuments({ userId: user._id })).toBe(7);

    expect(await decisionEntry(user._id, 'anti_gaming_penalized')).toMatchObject({
      triggeredBy: 'admin', details: { note: 'Scripted challenge submissions', xp: { revoked: 2250 }, badgesRemoved: ['streak-30', 'problems-100'] },
    });
    const decision = await AntiGamingDecision.findById(data.decisionId).lean();
    expect(decision).toMatchObject({ action: 'penalize', xp: { revoked: 2250, totalAfter: 800 }, badgesRemoved: ['streak-30', 'problems-100'] });

    // A clean rebuild or sweep cannot bring back the flag or the badges.
    await XpTransaction.deleteMany({ userId: user._id });
    await AntiGamingWorker.startAuditJob(new Date(Date.now() + DAY));
    expect(await PublicProfile.findOne({ userId: user._id }).lean()).toMatchObject({
      antiGaming: { isFlagged: true, suspicionScore: 0, review: { status: 'confirmed_gaming' } }, snapshot: { achievements: [] },
    });
    expect(await ProfileAuditLog.countDocuments({ userId: user._id, eventType: 'flag_cleared' })).toBe(0);
    // Even if something writes badges back or clears the flag, the next derivation restores the penalty.
    await PublicProfile.updateOne({ userId: user._id }, { $set: { 'snapshot.achievements': badges, 'antiGaming.isFlagged': false } });
    await applyAntiGamingReview(user._id);
    expect(await PublicProfile.findOne({ userId: user._id }).lean()).toMatchObject({ antiGaming: { isFlagged: true }, snapshot: { achievements: [] } });

    // A decision is final.
    const again = await action(user._id, admin.clerkId, { action: 'penalize', note: 'twice' });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('ALREADY_PENALIZED');
    expect((await action(user._id, admin.clerkId, { action: 'pardon', note: 'undo' })).status).toBe(409);
    expect(await AntiGamingDecision.countDocuments({ userId: user._id })).toBe(1);
  });

  it('shows the encrypted decision in the history and timeline and keeps the chain valid', async () => {
    const admin = await makeUser('admin');
    const user = await flaggedFarmer();
    expect((await action(user._id, admin.clerkId, { action: 'penalize', note: 'farmed' })).status).toBe(200);

    const list = await (await call('/api/v2/ops/anti-gaming/flagged?state=confirmed', admin.clerkId)).json();
    expect(list.data[0].history.map((row: { eventType: string }) => row.eventType))
      .toEqual(expect.arrayContaining(['anti_gaming_penalized', 'flag_raised', 'anti_gaming_check']));

    const { data } = await (await call(`/api/v2/ops/anti-gaming/${user._id}/breakdown`, admin.clerkId)).json();
    expect(data.timeline[0]).toMatchObject({ eventType: 'anti_gaming_penalized', details: { note: 'farmed', actor: { id: String(admin._id) } } });
    expect(data.timeline[0]).not.toHaveProperty('encryptedDetails');
    expect(data.timeline[0]).not.toHaveProperty('subjectHash');
    expect(await verifyStoredAuditChain()).toEqual({ ok: true, checked: 1 });
  });

  it('uses an encrypted sweep entry as the baseline', async () => {
    const admin = await makeUser('admin');
    const user = await flaggedFarmer();
    expect((await action(user._id, admin.clerkId, { action: 'pardon', note: 'ok' })).status).toBe(200);
    // Newer than the pardon: a score above the threshold, but recorded as not flagged.
    await appendChainedAuditEvent({
      userId: user._id, eventType: 'anti_gaming_check', triggeredBy: 'system',
      details: { isFlagged: false }, suspicionScoreAfter: 80,
    });
    await AntiGamingWorker.startAuditJob(new Date(Date.now() + DAY));
    expect(await ProfileAuditLog.countDocuments({ userId: user._id, eventType: 'flag_cleared' })).toBe(0);
  });

  it('removes decisions when the account is erased', async () => {
    const admin = await makeUser('admin');
    const [user, other] = [await flaggedFarmer(), await flaggedFarmer()];
    for (const { _id } of [user, other]) {
      expect((await action(_id, admin.clerkId, { action: 'pardon', note: 'ok' })).status).toBe(200);
    }
    const row = await ProfileAuditLog.findOne({ ...await auditRowsFor(user._id), eventType: 'anti_gaming_pardoned' }).lean();

    const result = await executeAccountErasure(String(user._id), { deleteClerkAccount: false, clearRedisCache: false });
    expect(result.deletedCounts.AntiGamingDecision).toBe(1);
    expect(await AntiGamingDecision.countDocuments({ userId: user._id })).toBe(0);
    expect(await AntiGamingDecision.countDocuments({ userId: other._id })).toBe(1);
    expect(await decryptChainedAuditEvent(row!, user._id)).toBeNull();
    expect(await verifyStoredAuditChain()).toEqual({ ok: true, checked: 3 });
  });

  it('keeps decision records append-only', async () => {
    const admin = await makeUser('admin');
    const user = await flaggedFarmer();
    const { data } = await (await action(user._id, admin.clerkId, { action: 'pardon', note: 'fine' })).json();
    await expect(AntiGamingDecision.updateOne({ _id: data.decisionId }, { $set: { note: 'edited' } })).rejects.toThrow('append-only');
    await expect(AntiGamingDecision.deleteOne({ _id: data.decisionId })).rejects.toThrow('append-only');
    const doc = await AntiGamingDecision.findById(data.decisionId);
    doc!.note = 'edited';
    await expect(doc!.save()).rejects.toThrow('append-only');
    expect(await AntiGamingDecision.findById(data.decisionId).lean()).toMatchObject({ note: 'fine' });
  });

  it('rejects a pardon for a profile that is not flagged and validates the body', async () => {
    const admin = await makeUser('admin');
    const user = await makeUser();
    await seedProfile(user, {});
    const notFlagged = await action(user._id, admin.clerkId, { action: 'pardon', note: 'nothing to do' });
    expect(notFlagged.status).toBe(409);
    expect((await notFlagged.json()).code).toBe('NOT_FLAGGED');
    expect((await action(user._id, admin.clerkId, { action: 'pardon' })).status).toBe(400);
    expect((await action(user._id, admin.clerkId, { action: 'pardon', note: '   ' })).status).toBe(400);
    expect((await action(user._id, admin.clerkId, { action: 'ban', note: 'x' })).status).toBe(400);
    expect((await action(new Types.ObjectId(), admin.clerkId, { action: 'penalize', note: 'x' })).status).toBe(404);
  });
});

describe('access control', () => {
  it('needs an ops role to read and an admin to act', async () => {
    const [member, auditor] = await Promise.all([makeUser(), makeUser('moderator')]);
    const user = await flaggedFarmer();
    const reads = ['/api/v2/ops/anti-gaming/flagged', `/api/v2/ops/anti-gaming/${user._id}/breakdown`];

    for (const path of reads) {
      expect((await call(path)).status).toBe(401);
      expect((await call(path, member.clerkId)).status).toBe(403);
      expect((await call(path, auditor.clerkId)).status).toBe(200);
    }
    expect((await action(user._id, '', { action: 'pardon', note: 'x' })).status).toBe(401);
    expect((await action(user._id, member.clerkId, { action: 'pardon', note: 'x' })).status).toBe(403);
    expect((await action(user._id, auditor.clerkId, { action: 'penalize', note: 'x' })).status).toBe(403);

    expect(await PublicProfile.findOne({ userId: user._id }).lean()).toMatchObject({ antiGaming: { isFlagged: true, review: null } });
    expect(await ProfileAuditLog.countDocuments({ eventType: { $in: ['anti_gaming_pardoned', 'anti_gaming_penalized'] } })).toBe(0);
    expect(await AntiGamingDecision.countDocuments()).toBe(0);
  });

  it('is served on v1 too, and does not expose the other ops routes on v2', async () => {
    const admin = await makeUser('admin');
    expect((await call('/api/v1/ops/anti-gaming/flagged', admin.clerkId)).status).toBe(200);
    expect((await call('/api/v2/ops/queues', admin.clerkId)).status).toBe(404);
  });
});
