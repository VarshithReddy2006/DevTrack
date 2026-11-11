import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { ProfileAuditLog } from '../../db/models/profileAuditLog.model.js';
import { PublicProfile } from '../../db/models/publicProfile.model.js';
import { User } from '../../db/models/user.model.js';
import { subtractDays } from '../../shared/date.js';
import { logger } from '../../shared/logger.js';
import { PublicProfileService } from './publicProfile.service.js';

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
        const auditId = new Types.ObjectId(createHash('sha256')
          .update(`anti-gaming:${day}:${_id}`).digest('hex').slice(0, 24));
        try {
          if (await ProfileAuditLog.exists({ _id: auditId })) continue;

          const score = await PublicProfileService.computeProfile(_id);
          await PublicProfile.updateOne({ userId: _id }, { $max: { 'antiGaming.lastAuditedAt': scheduledAt } });
          await ProfileAuditLog.updateOne(
            { _id: auditId },
            {
              $setOnInsert: {
                userId: _id,
                eventType: 'anti_gaming_check',
                triggeredBy: 'system',
                details: score,
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
}
