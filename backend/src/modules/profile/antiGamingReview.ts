// src/modules/profile/antiGamingReview.ts: combines the raw anti-gaming result with the
// latest maintainer decision stored on the profile.
import type { Types } from 'mongoose';
import { PublicProfile } from '../../db/models/publicProfile.model.js';
import { SUSPICION_FLAG_THRESHOLD } from './verification.engine.js';

const status = '$antiGaming.review.status';

/**
 * Recomputes `antiGaming.isFlagged` from the stored score, flags and review in one pipeline
 * update. Because it reads the review that is stored at that moment, a pardon or penalty that
 * lands while a rebuild is running is never overwritten by the rebuild.
 *
 * - confirmed gaming: always flagged, badges stay removed
 * - pardoned: unflagged while the flags are a subset of the pardoned ones; a new flag re-flags,
 *   and a clean audit ends the pardon so the next episode needs a new review
 * - no review: flagged when the score is above the threshold
 */
export async function applyAntiGamingReview(userId: Types.ObjectId | string): Promise<void> {
  await PublicProfile.updateOne({ userId }, [{
    $set: {
      'antiGaming.isFlagged': {
        $switch: {
          branches: [
            { case: { $eq: [status, 'confirmed_gaming'] }, then: true },
            {
              case: { $and: [
                { $eq: [status, 'pardoned'] },
                { $setIsSubset: [{ $ifNull: ['$antiGaming.flags', []] }, { $ifNull: ['$antiGaming.review.flags', []] }] },
              ] },
              then: false,
            },
          ],
          default: { $gt: ['$antiGaming.suspicionScore', SUSPICION_FLAG_THRESHOLD] },
        },
      },
      'antiGaming.review': {
        $cond: [
          { $and: [{ $eq: [status, 'pardoned'] }, { $lte: ['$antiGaming.suspicionScore', SUSPICION_FLAG_THRESHOLD] }] },
          null,
          '$antiGaming.review',
        ],
      },
      'snapshot.achievements': { $cond: [{ $eq: [status, 'confirmed_gaming'] }, [], '$snapshot.achievements'] },
    },
  }]);
}
