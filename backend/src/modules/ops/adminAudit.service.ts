// src/modules/ops/adminAudit.service.ts: maintainer review of anti-gaming flags.
//
// AntiGamingWorker flags profiles; this is where a maintainer looks at why and either pardons
// the profile or confirms the gaming. Every decision is written twice: an encrypted, hash-chained
// ProfileAuditLog row for the timeline (90 day TTL) and an AntiGamingDecision row that stays as long
// as the account does.
import { Types } from 'mongoose';
import { ActivityEvent } from '../../db/models/activityEvent.model.js';
import { AntiGamingDecision, type AntiGamingAction } from '../../db/models/antiGamingDecision.model.js';
import { DsaProblem } from '../../db/models/dsaProblem.model.js';
import { PlatformStats } from '../../db/models/platformStats.model.js';
import { ProfileAuditLog } from '../../db/models/profileAuditLog.model.js';
import { PublicProfile, type AntiGamingReview, type IPublicProfile } from '../../db/models/publicProfile.model.js';
import { User } from '../../db/models/user.model.js';
import { UserAnalytics } from '../../db/models/userAnalytics.model.js';
import { UserXp } from '../../db/models/userXp.model.js';
import { XpTransaction } from '../../db/models/xpTransaction.model.js';
import { runInTransaction } from '../../db/transaction.js';
import { createPagination, getSkipCount, type PaginationParams } from '../../shared/pagination.js';
import { invalidateCacheTag, portfolioTag } from '../../shared/redis/cacheTags.js';
import {
  maxXpInWindow,
  XP_BURST_LIMIT,
  XP_BURST_WINDOW_MS,
  XP_SUSTAINED_LIMIT,
  XP_SUSTAINED_WINDOW_MS,
  XP_VELOCITY_IGNORED_SOURCES,
  XP_VELOCITY_LOOKBACK_MS,
} from '../profile/verification.engine.js';
import { calculateLevel, xpToNextLevel } from '../xp/rules.js';
import { appendChainedAuditEvent, auditRowsFor, decryptChainedAuditEvent } from '../audit/auditLedger.service.js';

const DAY_MS = 86_400_000;
const HISTORY_EVENTS = ['anti_gaming_check', 'flag_raised', 'flag_cleared', 'anti_gaming_pardoned', 'anti_gaming_penalized'];
const HISTORY_PER_PROFILE = 5;
const SOLVE_WINDOW_DAYS = 30;
const COMMIT_WINDOW_DAYS = 90;
const RECENT_LIMIT = 50;
const TIMELINE_LIMIT = 100;
/** Same cap the verification engine uses, so one runaway account cannot blow up a breakdown. */
const MAX_LEDGER_ROWS = 20_000;
const HARD_BURST_WINDOW_MS = 10 * 60_000;

export class AdminAuditError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode: number) {
    super(message);
    this.name = 'AdminAuditError';
  }
}

export const FLAGGED_STATES = ['open', 'confirmed', 'pardoned'] as const;
export type FlaggedState = typeof FLAGGED_STATES[number];

const STATE_FILTERS: Record<FlaggedState, Record<string, unknown>> = {
  // Waiting for a maintainer: flagged and not already confirmed.
  open: { 'antiGaming.isFlagged': true, 'antiGaming.review.status': { $ne: 'confirmed_gaming' } },
  confirmed: { 'antiGaming.review.status': 'confirmed_gaming' },
  pardoned: { 'antiGaming.review.status': 'pardoned' },
};

export interface ReviewActor {
  id: string;
  username: string;
  role: string;
}

type AntiGamingState = IPublicProfile['antiGaming'];

function reviewView(review: AntiGamingReview | null | undefined) {
  if (!review) return null;
  return {
    status: review.status,
    flags: review.flags ?? [],
    note: review.note,
    decidedBy: String(review.decidedBy),
    decidedAt: review.decidedAt,
    decisionId: String(review.decisionId),
  };
}

function antiGamingView(antiGaming: Partial<AntiGamingState> | undefined) {
  return {
    suspicionScore: antiGaming?.suspicionScore ?? 0,
    flags: antiGaming?.flags ?? [],
    isFlagged: antiGaming?.isFlagged === true,
    lastAuditedAt: antiGaming?.lastAuditedAt ?? null,
    review: reviewView(antiGaming?.review),
  };
}

/** Flagged profiles, highest suspicion first, each with its latest anti-gaming audit entries. */
export async function listFlaggedProfiles(state: FlaggedState, params: PaginationParams) {
  const filter = STATE_FILTERS[state];
  const [rows, total] = await Promise.all([
    PublicProfile.aggregate<{
      userId: Types.ObjectId; username: string; slug: string; published?: boolean;
      antiGaming?: AntiGamingState;
    }>([
      { $match: filter },
      { $sort: { 'antiGaming.suspicionScore': -1, _id: 1 } },
      { $skip: getSkipCount(params) },
      { $limit: params.pageSize },
      { $project: { _id: 0, userId: 1, username: 1, slug: 1, published: 1, antiGaming: 1 } },
    ]),
    PublicProfile.countDocuments(filter),
  ]);
  const histories = await Promise.all(rows.map(async row => ProfileAuditLog
    .find({ ...await auditRowsFor(row.userId), eventType: { $in: HISTORY_EVENTS } })
    .sort({ createdAt: -1 }).limit(HISTORY_PER_PROFILE)
    .select('-_id eventType triggeredBy suspicionScoreBefore suspicionScoreAfter createdAt').lean()));

  return {
    items: rows.map((row, index) => ({
      userId: String(row.userId),
      username: row.username,
      slug: row.slug,
      published: row.published === true,
      ...antiGamingView(row.antiGaming),
      history: histories[index],
    })),
    pagination: createPagination(total, params),
  };
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The anti-gaming audit entries of one user, newest first, with encrypted details opened. */
async function auditTimeline(owner: Types.ObjectId) {
  const rows = await ProfileAuditLog.find({ ...await auditRowsFor(owner), eventType: { $in: HISTORY_EVENTS } })
    .sort({ createdAt: -1 }).limit(TIMELINE_LIMIT)
    .select('eventType triggeredBy details encryptedDetails subjectHash suspicionScoreBefore suspicionScoreAfter createdAt').lean();
  return Promise.all(rows.map(async ({ encryptedDetails, subjectHash, details, ...row }) => ({
    ...row,
    details: encryptedDetails ? await decryptChainedAuditEvent({ encryptedDetails, subjectHash }, owner) : details,
  })));
}

/**
 * Everything a maintainer needs to judge a flag: the inputs the verification engine scored,
 * solve and XP velocity series, recent commits with their hour-of-day spread, the audit
 * timeline and earlier decisions.
 */
export async function getFlagBreakdown(userId: string, now = new Date()) {
  const owner = new Types.ObjectId(userId);
  const profile = await PublicProfile.findOne({ userId: owner }).select('userId username slug published antiGaming').lean();
  if (!profile) throw new AdminAuditError('Profile not found', 'NOT_FOUND', 404);

  const solveSince = new Date(now.getTime() - SOLVE_WINDOW_DAYS * DAY_MS);
  const xpSince = new Date(now.getTime() - XP_VELOCITY_LOOKBACK_MS);
  const commitSince = new Date(now.getTime() - COMMIT_WINDOW_DAYS * DAY_MS);
  const githubCommits = { userId: owner, platform: 'github', type: 'commit_pushed', occurredAt: { $gte: commitSince, $lte: now } };

  const [user, platforms, solvesByDay, recentSolves, hardSolves, xpRows, recentCommits, commitHours, timeline, decisions] = await Promise.all([
    User.findById(owner).select('joinedAt').lean(),
    PlatformStats.find({ userId: owner, platformName: { $in: ['leetcode', 'github'] } })
      .select('platformName totalSolved hardSolved rawData').lean(),
    DsaProblem.aggregate<{ _id: string; easy: number; medium: number; hard: number; total: number }>([
      { $match: { userId: owner, solvedAt: { $gte: solveSince, $lte: now } } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$solvedAt' } },
        easy: { $sum: { $cond: [{ $eq: ['$difficulty', 'easy'] }, 1, 0] } },
        medium: { $sum: { $cond: [{ $eq: ['$difficulty', 'medium'] }, 1, 0] } },
        hard: { $sum: { $cond: [{ $eq: ['$difficulty', 'hard'] }, 1, 0] } },
        total: { $sum: 1 },
      } },
      { $sort: { _id: 1 } },
    ]),
    DsaProblem.find({ userId: owner, solvedAt: { $gte: solveSince, $lte: now } })
      .sort({ solvedAt: -1 }).limit(RECENT_LIMIT).select('-_id title platform difficulty solvedAt').lean(),
    DsaProblem.find({ userId: owner, difficulty: 'hard', solvedAt: { $gte: solveSince, $lte: now } })
      .sort({ solvedAt: 1 }).limit(MAX_LEDGER_ROWS).select('-_id solvedAt').lean(),
    XpTransaction.find({ userId: owner, createdAt: { $gte: xpSince, $lte: now }, xpAwarded: { $gt: 0 } })
      .sort({ createdAt: 1 }).limit(MAX_LEDGER_ROWS).select('-_id sourceType xpAwarded createdAt').lean(),
    ActivityEvent.find({ userId: owner, platform: 'github', type: { $in: ['commit_pushed', 'pr_merged'] }, occurredAt: { $gte: commitSince, $lte: now } })
      .sort({ occurredAt: -1 }).limit(RECENT_LIMIT).select('-_id type title url occurredAt').lean(),
    ActivityEvent.aggregate<{ _id: number; count: number }>([
      { $match: githubCommits },
      { $group: { _id: { $hour: '$occurredAt' }, count: { $sum: 1 } } },
    ]),
    // Anti-gaming entries only: other rows (dossier downloads) carry viewer IPs that reviewers do not need.
    auditTimeline(owner),
    AntiGamingDecision.find({ userId: owner }).sort({ createdAt: -1 }).select('-__v').lean(),
  ]);

  const leetcode = platforms.find(p => p.platformName === 'leetcode');
  const github = platforms.find(p => p.platformName === 'github');
  const githubRaw = (github?.rawData ?? {}) as Record<string, unknown>;

  // Same windows and exclusions as VerificationEngine, so the peaks explain the flag.
  const counted = xpRows
    .filter(row => !XP_VELOCITY_IGNORED_SOURCES.includes(row.sourceType))
    .map(row => ({ at: row.createdAt.getTime(), xp: row.xpAwarded }));
  const hourly = new Map<string, number>();
  for (const { at, xp } of counted) {
    const hour = new Date(Math.floor(at / 3_600_000) * 3_600_000).toISOString();
    hourly.set(hour, (hourly.get(hour) ?? 0) + xp);
  }
  const byHour = Array.from({ length: 24 }, (_, hour) => commitHours.find(row => row._id === hour)?.count ?? 0);

  return {
    profile: {
      userId: String(profile.userId),
      username: profile.username,
      slug: profile.slug,
      published: profile.published === true,
      ...antiGamingView(profile.antiGaming),
    },
    signals: {
      accountAgeDays: user?.joinedAt ? Math.floor((now.getTime() - user.joinedAt.getTime()) / DAY_MS) : null,
      leetcode: leetcode ? { totalSolved: leetcode.totalSolved ?? 0, hardSolved: leetcode.hardSolved ?? 0 } : null,
      github: github ? { totalCommits: numeric(githubRaw.total_commits), publicRepos: numeric(githubRaw.public_repos) } : null,
    },
    solveVelocity: {
      since: solveSince,
      daily: solvesByDay.map(({ _id, ...counts }) => ({ date: _id, ...counts })),
      // Most hard problems solved inside any 10 minute window, e.g. 5 hards in 3 minutes shows as 5.
      maxHardIn10Minutes: maxXpInWindow(hardSolves.map(row => ({ at: row.solvedAt!.getTime(), xp: 1 })), HARD_BURST_WINDOW_MS),
      recent: recentSolves,
    },
    xpVelocity: {
      since: xpSince,
      countedXp: counted.reduce((sum, row) => sum + row.xp, 0),
      ignoredSources: XP_VELOCITY_IGNORED_SOURCES,
      peak10Minutes: maxXpInWindow(counted, XP_BURST_WINDOW_MS),
      peak60Minutes: maxXpInWindow(counted, XP_SUSTAINED_WINDOW_MS),
      limits: { per10Minutes: XP_BURST_LIMIT, per60Minutes: XP_SUSTAINED_LIMIT },
      hourly: [...hourly].map(([hour, xp]) => ({ hour, xp })),
    },
    commits: {
      since: commitSince,
      // Commits per UTC hour of day; people sleep, scripts do not.
      byHourUtc: byHour,
      recent: recentCommits,
    },
    timeline,
    decisions: decisions.map(({ _id, ...rest }) => ({ id: String(_id), ...rest })),
  };
}

export interface ActionResult {
  userId: string;
  action: AntiGamingAction;
  decisionId: string;
  auditLogId: string;
  review: ReturnType<typeof reviewView>;
  xp: { revoked: number; transactions: number; since: Date; totalBefore: number; totalAfter: number; levelBefore: number; levelAfter: number } | null;
  badgesRemoved: string[];
}

function profileChanged(): AdminAuditError {
  return new AdminAuditError('The profile changed while the decision was being saved, reload and try again', 'PROFILE_CHANGED', 409);
}

/**
 * Pardon: clears the flag and records which flags were looked at. The profile rebuild keeps it
 * unflagged while those are the only flags (see applyAntiGamingReview), so the next sweep does
 * not undo the decision.
 */
async function pardon(owner: Types.ObjectId, note: string, actor: ReviewActor, now: Date): Promise<ActionResult> {
  return runInTransaction(async session => {
    const profile = await PublicProfile.findOne({ userId: owner }).session(session).select('antiGaming').lean();
    if (!profile) throw new AdminAuditError('Profile not found', 'NOT_FOUND', 404);
    const antiGaming = antiGamingView(profile.antiGaming);
    if (antiGaming.review?.status === 'confirmed_gaming') {
      throw new AdminAuditError('Gaming was already confirmed for this profile', 'ALREADY_PENALIZED', 409);
    }
    if (!antiGaming.isFlagged) throw new AdminAuditError('This profile is not flagged', 'NOT_FLAGGED', 409);

    const decisionId = new Types.ObjectId();
    const audit = await appendChainedAuditEvent({
      userId: owner,
      eventType: 'anti_gaming_pardoned',
      triggeredBy: 'admin',
      details: { decisionId: String(decisionId), note, actor, flags: antiGaming.flags, isFlagged: false },
      suspicionScoreBefore: antiGaming.suspicionScore,
      suspicionScoreAfter: antiGaming.suspicionScore,
    }, session);
    await AntiGamingDecision.create([{
      _id: decisionId,
      userId: owner,
      action: 'pardon',
      note,
      actor: { userId: new Types.ObjectId(actor.id), username: actor.username, role: actor.role },
      suspicionScore: antiGaming.suspicionScore,
      flags: antiGaming.flags,
      auditLogId: audit._id,
    }], { session });

    const review: AntiGamingReview = {
      status: 'pardoned', flags: antiGaming.flags, note,
      decidedBy: new Types.ObjectId(actor.id), decidedAt: now, decisionId,
    };
    // Guarded on what the maintainer saw, so a rebuild that changed the flags is not pardoned blindly.
    const updated = await PublicProfile.updateOne(
      { _id: profile._id, 'antiGaming.isFlagged': true, 'antiGaming.flags': antiGaming.flags },
      { $set: { 'antiGaming.isFlagged': false, 'antiGaming.review': review } },
      { session },
    );
    if (!updated.matchedCount) throw profileChanged();

    return {
      userId: String(owner), action: 'pardon', decisionId: String(decisionId), auditLogId: String(audit._id),
      review: reviewView(review), xp: null, badgesRemoved: [],
    };
  });
}

/**
 * Penalize: confirms the gaming. XP earned from the flagged window onward is taken back (the
 * engine's 7 day look-back before the latest flag, manual grants excluded), derived badges are
 * removed and the profile stays flagged for good.
 */
async function penalize(owner: Types.ObjectId, note: string, actor: ReviewActor, now: Date): Promise<ActionResult> {
  return runInTransaction(async session => {
    const profile = await PublicProfile.findOne({ userId: owner }).session(session).select('antiGaming snapshot.achievements').lean();
    if (!profile) throw new AdminAuditError('Profile not found', 'NOT_FOUND', 404);
    const antiGaming = antiGamingView(profile.antiGaming);
    if (antiGaming.review?.status === 'confirmed_gaming') {
      throw new AdminAuditError('Gaming was already confirmed for this profile', 'ALREADY_PENALIZED', 409);
    }

    const flaggedAt = (await ProfileAuditLog.findOne({ ...await auditRowsFor(owner, session), eventType: 'flag_raised' })
      .sort({ createdAt: -1 }).select('createdAt').session(session).lean())?.createdAt ?? now;
    const since = new Date(flaggedAt.getTime() - XP_VELOCITY_LOOKBACK_MS);
    const [gained] = await XpTransaction.aggregate<{ xp: number; count: number }>([
      { $match: { userId: owner, createdAt: { $gte: since }, sourceType: { $ne: 'manual' }, xpAwarded: { $gt: 0 } } },
      { $group: { _id: null, xp: { $sum: '$xpAwarded' }, count: { $sum: 1 } } },
    ]).session(session);

    const wallet = await UserXp.findOne({ userId: owner }).session(session).lean();
    const totalBefore = wallet?.totalXp ?? 0;
    const levelBefore = wallet?.currentLevel ?? 1;
    const revoked = Math.min(totalBefore, gained?.xp ?? 0);
    const totalAfter = totalBefore - revoked;
    const levelAfter = calculateLevel(totalAfter);
    if (wallet && revoked > 0) {
      await UserXp.updateOne(
        { _id: wallet._id },
        { $set: { totalXp: totalAfter, currentLevel: levelAfter, xpToNextLevel: xpToNextLevel(totalAfter, levelAfter) } },
        { session },
      );
      // The dashboard copy only ever moves up ($max), so set it down explicitly.
      await UserAnalytics.updateOne({ userId: owner }, { $set: { totalXp: totalAfter, currentLevel: levelAfter } }, { session });
    }
    const xp = { revoked, transactions: gained?.count ?? 0, since, totalBefore, totalAfter, levelBefore, levelAfter };
    const badgesRemoved = (profile.snapshot?.achievements ?? []).map(({ id }) => id);

    const decisionId = new Types.ObjectId();
    const audit = await appendChainedAuditEvent({
      userId: owner,
      eventType: 'anti_gaming_penalized',
      triggeredBy: 'admin',
      details: { decisionId: String(decisionId), note, actor, flags: antiGaming.flags, xp, badgesRemoved, isFlagged: true },
      suspicionScoreBefore: antiGaming.suspicionScore,
      suspicionScoreAfter: antiGaming.suspicionScore,
    }, session);
    await AntiGamingDecision.create([{
      _id: decisionId,
      userId: owner,
      action: 'penalize',
      note,
      actor: { userId: new Types.ObjectId(actor.id), username: actor.username, role: actor.role },
      suspicionScore: antiGaming.suspicionScore,
      flags: antiGaming.flags,
      xp,
      badgesRemoved,
      auditLogId: audit._id,
    }], { session });

    const review: AntiGamingReview = {
      status: 'confirmed_gaming', flags: antiGaming.flags, note,
      decidedBy: new Types.ObjectId(actor.id), decidedAt: now, decisionId,
    };
    const updated = await PublicProfile.updateOne(
      { _id: profile._id, 'antiGaming.review.status': { $ne: 'confirmed_gaming' } },
      { $set: { 'antiGaming.isFlagged': true, 'antiGaming.review': review, 'snapshot.achievements': [] } },
      { session },
    );
    if (!updated.matchedCount) throw profileChanged();

    return {
      userId: String(owner), action: 'penalize', decisionId: String(decisionId), auditLogId: String(audit._id),
      review: reviewView(review), xp, badgesRemoved,
    };
  });
}

export async function applyReviewAction(
  userId: string,
  action: AntiGamingAction,
  note: string,
  actor: ReviewActor,
  now = new Date(),
): Promise<ActionResult> {
  const owner = new Types.ObjectId(userId);
  const result = action === 'pardon' ? await pardon(owner, note, actor, now) : await penalize(owner, note, actor, now);
  // Public portfolio reads also check the live flag, so a failed invalidation only delays the change.
  await invalidateCacheTag(portfolioTag(userId));
  return result;
}
