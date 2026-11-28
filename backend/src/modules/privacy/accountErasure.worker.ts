// src/modules/privacy/accountErasure.worker.ts — GDPR Right to be Forgotten Erasure Worker
import mongoose, { Types, type ClientSession } from 'mongoose';
import {
  User,
  UserProfile,
  UserSettings,
  DsaSubmission,
  DsaProfile,
  DsaTopicProgress,
  Project,
  ProjectTask,
  ResumeProfile,
  ResumeVersion,
  ResumeBulletRevision,
  ResumeExport,
  ResumeEvidenceClaim,
  ResumeSession,
  ResumeVariant,
  ResumeCredibility,
  RevisionCard,
  InterviewReport,
  JobTarget,
  PublicProfile,
  FocusSession,
  UserQuestProgress,
  UserStreakLog,
  UserXp,
  XpTransaction,
  DailyActivity,
  DailyChallengeAssignment,
  ConnectedPlatform,
  NotificationRecord,
  NotificationPreference,
  CareerIntent,
  CareerRoadmap,
  CustomDomain,
} from '../../db/models/index.js';
import { runInTransaction } from '../../db/transaction.js';
import { logger } from '../../shared/logger.js';
import { getRedisClient, isRedisConfigured } from '../../shared/redis/index.js';
import { appendErasureTombstone, destroyAuditKey } from '../audit/auditLedger.service.js';
import { eraseAntiGamingDecisions } from '../../db/models/antiGamingDecision.model.js';

export interface AccountErasureOptions {
  deleteClerkAccount?: boolean;
  clearRedisCache?: boolean;
  anonymizeAuditLogs?: boolean;
}

export interface ErasureResult {
  userId: string;
  clerkId: string | null;
  deletedCounts: Record<string, number>;
  tombstoneAppended: boolean;
  shreddedAuditKeys: number;
  clearedRedisKeys: number;
  clerkDeleted: boolean;
  completedAt: string;
}

/**
 * Executes cascading account deletion within a MongoDB transaction.
 * Permanently removes user records across collections, crypto-shreds audit encryption keys,
 * appends an immutable ACCOUNT_ERASURE_TOMBSTONE to preserve the audit hash chain,
 * clears Redis cache keys, and removes the account from Clerk.
 */
export async function executeAccountErasure(
  userId: string,
  options: AccountErasureOptions = {}
): Promise<ErasureResult> {
  const { deleteClerkAccount = true, clearRedisCache = true, anonymizeAuditLogs = true } = options;
  const userObjectId = Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : null;
  const userFilter = userObjectId ? { $or: [{ userId: userObjectId }, { userId: String(userId) }] } : { userId };

  logger.info('[privacy-erasure] Initiating cascading account deletion', { userId });

  // 1. Fetch user identity to resolve Clerk ID and username for Redis cache invalidation
  const userDoc = await User.findById(userId).lean().catch(() => null);
  const clerkId = userDoc?.clerkId ?? null;
  const username = userDoc?.username ?? null;

  const deletedCounts: Record<string, number> = {};
  let tombstoneAppended = false;
  let shreddedAuditKeys = 0;

  // 2. Perform transactional cascading deletion across database collections
  const cascadeOperations = async (session: ClientSession | null) => {
    const sessionOpts = session ? { session } : {};

    // Resolve user's projects first so ProjectTask can be cascade deleted by projectId (ProjectTask schema has no userId)
    const userProjects = await Project.find(userFilter, { _id: 1 }, sessionOpts).lean();
    const projectIds = userProjects.map((p) => p._id);

    // Resolve user's resume sessions to cascade delete ResumeCredibility by sessionId
    const userSessions = await ResumeSession.find(userFilter, { sessionId: 1 }, sessionOpts).lean();
    const sessionIds = userSessions.map((s: any) => s.sessionId).filter(Boolean);

    // Cascade deletions across all related user collections
    const modelsToCascade: Array<[string, any, any]> = [
      ['User', User, { _id: userId }],
      ['UserProfile', UserProfile, userFilter],
      ['UserSettings', UserSettings, userFilter],
      ['DsaSubmission', DsaSubmission, userFilter],
      ['DsaProfile', DsaProfile, userFilter],
      ['DsaTopicProgress', DsaTopicProgress, userFilter],
      ['Project', Project, userFilter],
      ['ProjectTask', ProjectTask, { projectId: { $in: projectIds } }],
      ['ResumeProfile', ResumeProfile, userFilter],
      ['ResumeVersion', ResumeVersion, userFilter],
      ['ResumeBulletRevision', ResumeBulletRevision, userFilter],
      ['ResumeExport', ResumeExport, userFilter],
      ['ResumeEvidenceClaim', ResumeEvidenceClaim, userFilter],
      ['ResumeSession', ResumeSession, userFilter],
      ['ResumeVariant', ResumeVariant, userFilter],
      ['ResumeCredibility', ResumeCredibility, { sessionId: { $in: sessionIds } }],
      ['RevisionCard', RevisionCard, userFilter],
      ['InterviewReport', InterviewReport, userFilter],
      ['JobTarget', JobTarget, userFilter],
      ['PublicProfile', PublicProfile, userFilter],
      ['FocusSession', FocusSession, userFilter],
      ['UserQuestProgress', UserQuestProgress, userFilter],
      ['UserStreakLog', UserStreakLog, userFilter],
      ['UserXp', UserXp, userFilter],
      ['XpTransaction', XpTransaction, userFilter],
      ['DailyActivity', DailyActivity, userFilter],
      ['DailyChallengeAssignment', DailyChallengeAssignment, userFilter],
      ['ConnectedPlatform', ConnectedPlatform, userFilter],
      ['NotificationRecord', NotificationRecord, { userId: String(userId) }],
      ['NotificationPreference', NotificationPreference, { userId: String(userId) }],
      ['CareerIntent', CareerIntent, userFilter],
      ['CareerRoadmap', CareerRoadmap, userFilter],
      ['CustomDomain', CustomDomain, userFilter],
    ];

    if (mongoose.models.InterviewSession) {
      modelsToCascade.push(['InterviewSession', mongoose.models.InterviewSession, userFilter]);
    }

    const delPromises = modelsToCascade.map(async ([name, model, filter]) => {
      if (model && typeof model.deleteMany === 'function') {
        const res = await model.deleteMany(filter, sessionOpts);
        deletedCounts[name] = res.deletedCount ?? 0;
      } else if (model && typeof model.deleteOne === 'function') {
        const res = await model.deleteOne(filter, sessionOpts);
        deletedCounts[name] = res.deletedCount ?? 0;
      }
    });

    await Promise.all(delPromises);
    if (userObjectId) {
      deletedCounts.AntiGamingDecision = await eraseAntiGamingDecisions(userObjectId, session);
    }

    // Crypto-shred the user's audit encryption key and append an immutable
    // ACCOUNT_ERASURE_TOMBSTONE record without mutating existing ProfileAuditLog rows.
    if (anonymizeAuditLogs && userObjectId) {
      const { shreddedCount, subjectHash } = await destroyAuditKey(userObjectId, session);
      shreddedAuditKeys = shreddedCount;
      await appendErasureTombstone(
        {
          userId: String(userId),
          subjectRef: subjectHash,
          keyDestroyed: shreddedCount > 0,
        },
        session
      );
      tombstoneAppended = true;
    }
  };

  try {
    await runInTransaction(async (session) => {
      await cascadeOperations(session);
    });
  } catch (err: any) {
    // Fallback for single-node development or test environments where replica sets are not configured
    if (
      err?.message?.includes('replica set') ||
      err?.message?.includes('Transaction numbers are only allowed') ||
      err?.codeName === 'CommandNotSupportedOnStandalone'
    ) {
      logger.warn('[privacy-erasure] Executing non-transactional cascade fallback', { error: err.message });
      await cascadeOperations(null);
    } else {
      logger.error('[privacy-erasure] Transactional erasure failed', err);
      throw err;
    }
  }

  // 3. Clear Redis cache keys and leaderboard scores
  let clearedRedisKeys = 0;
  if (clearRedisCache && isRedisConfigured()) {
    try {
      const redis = getRedisClient();
      const patterns = [
        `user:${userId}:*`,
        `user:${userId}`,
        `sse:seq:${userId}`,
        `sse:stream:${userId}*`,
        `rate_limit:*:${userId}*`,
        `rl:*:${userId}*`,
      ];

      if (clerkId) patterns.push(`user:${clerkId}:*`, `user:${clerkId}`);
      if (username) patterns.push(`portfolio:${username}*`);
      patterns.push(`portfolio:user:${userId}*`);

      if (typeof (redis as any).scan === 'function') {
        for (const pattern of patterns) {
          let cursor = '0';
          do {
            const [nextCursor, keys] = await (redis as any).scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = nextCursor;
            if (keys && keys.length > 0) {
              await redis.del(...keys);
              clearedRedisKeys += keys.length;
            }
          } while (cursor !== '0');
        }
      }

      // Remove from leaderboards
      if (typeof (redis as any).zrem === 'function') {
        await Promise.allSettled([
          (redis as any).zrem('leaderboard:all', userId),
          (redis as any).zrem('leaderboard:weekly', userId),
          (redis as any).zrem('leaderboard:monthly', userId),
        ]);
      }
    } catch (redisErr) {
      logger.warn('[privacy-erasure] Redis cache purge encountered non-fatal error', { error: redisErr });
    }
  }

  // 4. Revoke active Clerk sessions and delete Clerk user
  let clerkDeleted = false;
  if (deleteClerkAccount && clerkId && process.env.CLERK_SECRET_KEY) {
    try {
      const { clerkClient } = await import('@clerk/express');
      await clerkClient.users.deleteUser(clerkId);
      clerkDeleted = true;
      logger.info('[privacy-erasure] Deleted Clerk identity account', { clerkId });
    } catch (clerkErr: any) {
      logger.warn('[privacy-erasure] Clerk user deletion failed or user already absent', {
        clerkId,
        error: clerkErr?.message,
      });
    }
  }

  const result: ErasureResult = {
    userId,
    clerkId,
    deletedCounts,
    tombstoneAppended,
    shreddedAuditKeys,
    clearedRedisKeys,
    clerkDeleted,
    completedAt: new Date().toISOString(),
  };

  logger.info('[privacy-erasure] Account erasure completed successfully', { ...result });
  return result;
}
