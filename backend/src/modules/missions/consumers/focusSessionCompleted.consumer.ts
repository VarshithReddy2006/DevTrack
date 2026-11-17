import { Types } from 'mongoose';
import { Mission } from '../../../db/models/mission.model.js';
import { cacheManager } from '../../../shared/cache/cacheManager.js';
import type { ConsumerDefinition } from '../../../shared/events/consumerRegistry.js';
import type { FocusSessionCompletedV1 } from '../../../shared/events/eventContract.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { eventBus } from '../../../shared/sse/index.js';
import { processMissionReward } from '../../xp/processor.js';

function focusMissions(userId: string, completedAt: Date) {
  return {
    userId: new Types.ObjectId(userId),
    type: 'daily',
    category: 'consistency',
    targetCount: { $gt: 0 },
    createdAt: { $lte: completedAt },
    expiresAt: { $gte: completedAt },
    // Current daily missions use the streak template. Also accept explicit focus
    // templates and titles on older rows that predate template keys.
    $or: [
      { templateKey: { $in: ['streak', 'focus'] } },
      { templateKey: { $exists: false }, title: /\b(focus|streak)\b/i },
    ],
  };
}

export const focusMissionConsumer: ConsumerDefinition<FocusSessionCompletedV1> = {
  name: 'missions.focusSessionCompleted',
  pool: 'xp',
  queue: QueueNames.DOMAIN_FOCUS_MISSIONS,
  dedup: 'inbox',
  retainInbox: true,
  async handle({ userId, payload }, session) {
    if (!session) throw new Error('Focus mission progress requires an inbox transaction');
    if (!payload.qualified) return;

    const completedAt = new Date(payload.completedAt);
    const missions = await Mission.find({
      ...focusMissions(userId, completedAt),
      status: { $in: ['pending', 'in_progress', 'expired'] },
    }).session(session);
    for (const mission of missions) {
      mission.currentCount = Math.min(mission.currentCount + 1, mission.targetCount);
      if (mission.currentCount >= mission.targetCount) {
        mission.status = 'completed';
        mission.completedAt = completedAt;
        mission.completedByFocusSessionId = payload.sessionId;
      } else if (mission.status !== 'expired') {
        mission.status = 'in_progress';
      }
      await mission.save({ session });
    }
  },
  async afterCommit({ userId, payload }) {
    if (!payload.qualified) return;
    const missions = await Mission.find(focusMissions(userId, new Date(payload.completedAt))).lean();
    if (!missions.length) return;
    await cacheManager.invalidateDashboard(userId);

    for (const mission of missions) {
      const missionId = String(mission._id);
      await eventBus.emitMissionProgress(userId, {
        missionId,
        title: mission.title,
        currentCount: mission.currentCount,
        targetCount: mission.targetCount,
        completed: mission.status === 'completed',
      });
      if (mission.completedByFocusSessionId === payload.sessionId) {
        // The mission ID is the reward's natural key. On retry the inbox skips
        // the increment but the same reward can still be settled.
        const reward = await processMissionReward(userId, missionId, payload.sessionId);
        if (reward.awarded) {
          await eventBus.emitNotificationCreated(
            userId, `mission_completion_${missionId}`, 'mission_completed',
            'Mission Complete! 🎉', `${mission.title} — +${reward.xpAwarded} XP`, 'celebration', 'medium',
          );
        }
      }
    }
  },
};
