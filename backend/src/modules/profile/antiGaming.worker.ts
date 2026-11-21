import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { ProfileAuditLog } from '../../db/models/profileAuditLog.model.js';
import { PublicProfile } from '../../db/models/publicProfile.model.js';
import { User } from '../../db/models/user.model.js';
import { subtractDays } from '../../shared/date.js';
import { createDomainEvent, type ProfileFlaggedPayload } from '../../shared/events/eventContract.js';
import { runConsumersForEvent } from '../../shared/events/runConsumer.js';
import { logger } from '../../shared/logger.js';
import { auditRowsFor, decryptChainedAuditEvent } from '../audit/auditLedger.service.js';
import { PublicProfileService } from './publicProfile.service.js';
import { SUSPICION_FLAG_THRESHOLD } from './verification.engine.js';

/** Entries that record the flag state a later sweep compares against. */
const BASELINE_EVENTS = ['anti_gaming_check', 'anti_gaming_pardoned', 'anti_gaming_penalized'];

function auditIdFor(kind: string, day: string, userId: Types.ObjectId): Types.ObjectId {
  return new Types.ObjectId(createHash('sha256').update(`${kind}:${day}:${userId}`).digest('hex').slice(0, 24));
}

export class AntiGamingWorker {
  static async startAuditJob(scheduledAt: Date): Promise<void> {
    const day = scheduledAt.toISOString().slice(0, 10);
    const activeSince = subtractDays(scheduledAt, 90);
    let after: Types.ObjectId | undefined;
    let audited = 0;
    let failed = 0;

    while (true) {
      const users = await User.find({
        lastActiveAt: { $gte: activeSince },
        ...(after && { _id: { $gt: after } }),
      }).sort({ _id: 1 }).limit(50).select('_id').lean();

      if (!users.length) break;

      for (const { _id } of users) {
        const auditId = auditIdFor('anti-gaming', day, _id);
        try {
          if (await ProfileAuditLog.exists({ _id: auditId })) continue;

          // The previous audit (or maintainer decision) is the baseline, not the profile document:
          // profile rebuilds overwrite the score between sweeps and would hide a flag from the audit trail.
          // Focus and league checks reuse the event type without a score, so they are not a baseline.
          const previous = await ProfileAuditLog
            .findOne({ ...await auditRowsFor(_id), eventType: { $in: BASELINE_EVENTS }, suspicionScoreAfter: { $ne: null } })
            .sort({ createdAt: -1 }).select('suspicionScoreAfter details encryptedDetails subjectHash').lean();
          const before = previous?.suspicionScoreAfter ?? null;

          const score = await PublicProfileService.computeProfile(_id);
          const profile = await PublicProfile.findOneAndUpdate(
            { userId: _id },
            { $max: { 'antiGaming.lastAuditedAt': scheduledAt } },
            { new: true, projection: { 'antiGaming.isFlagged': 1 } },
          ).lean();

          // Entries written before reviews existed only have the score.
          const details = previous?.encryptedDetails ? await decryptChainedAuditEvent(previous, _id) : previous?.details;
          const recorded = details?.isFlagged;
          const wasFlagged = typeof recorded === 'boolean' ? recorded : before !== null && before > SUSPICION_FLAG_THRESHOLD;
          // The profile holds the effective state, which includes a pardon or a confirmed penalty.
          const isFlagged = profile?.antiGaming?.isFlagged ?? score.suspicionScore > SUSPICION_FLAG_THRESHOLD;
          if (isFlagged !== wasFlagged) {
            await this.recordFlagChange(_id, day, isFlagged, before, score);
          }

          // Written last: it marks the user as done for this day, so a crash above is retried.
          await ProfileAuditLog.updateOne(
            { _id: auditId },
            {
              $setOnInsert: {
                userId: _id,
                eventType: 'anti_gaming_check',
                triggeredBy: 'system',
                details: { ...score, isFlagged },
                suspicionScoreBefore: before,
                suspicionScoreAfter: score.suspicionScore,
              },
            },
            { upsert: true }
          );
          audited++;
        } catch (error) {
          failed++;
          logger.error('[AntiGamingWorker] Profile audit failed', { userId: String(_id), error });
        }
      }

      after = users[users.length - 1]._id;
    }

    logger.info('[AntiGamingWorker] Audit sweep finished', { audited, failed, day });
    if (failed) throw new Error(`Anti-gaming audit failed for ${failed} profiles`);
  }

  private static async recordFlagChange(
    userId: Types.ObjectId,
    day: string,
    isFlagged: boolean,
    before: number | null,
    score: { suspicionScore: number; flags: string[] },
  ): Promise<void> {
    const entryId = auditIdFor(isFlagged ? 'flag-raised' : 'flag-cleared', day, userId);
    await ProfileAuditLog.updateOne(
      { _id: entryId },
      {
        $setOnInsert: {
          userId,
          eventType: isFlagged ? 'flag_raised' : 'flag_cleared',
          triggeredBy: 'system',
          details: { flags: score.flags },
          suspicionScoreBefore: before,
          suspicionScoreAfter: score.suspicionScore,
        },
      },
      { upsert: true }
    );
    if (!isFlagged) return;

    const payload: ProfileFlaggedPayload = {
      suspicionScore: score.suspicionScore,
      previousSuspicionScore: before,
      flags: score.flags,
    };
    // Same id on a retry, so inbox-deduplicated consumers see one event.
    const event = { ...createDomainEvent('profile.flagged', payload, { userId: String(userId) }), id: String(entryId) };
    await runConsumersForEvent(event);
  }
}
