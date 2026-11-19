import { Types } from 'mongoose';
import { DsaContest } from '../../db/models/dsaContest.model.js';
import { DsaContestParticipation } from '../../db/models/dsaContestParticipation.model.js';
import { UserSettings } from '../../db/models/userSettings.model.js';
import { eventBus } from '../../shared/sse/eventBus.js';
import { logger } from '../../shared/logger.js';
import { ContestProviderRateLimit, fetchCodeforcesResults, fetchLeetcodeResult, type ContestResult } from './contestRatingSources.js';

export const CONTEST_RATING_DELAY_MS = 2 * 3600_000;
export const CONTEST_RATING_LOOKBACK_MS = 7 * 24 * 3600_000;
const resultFields = ['handle', 'rank', 'score', 'problemsSolved', 'ratingBefore', 'ratingAfter', 'ratingChange'] as const;

export async function syncContestRatings(contestId: string) {
  if (!Types.ObjectId.isValid(contestId)) throw new Error('Invalid contest ID');
  const observedAt = new Date();
  const contest = await DsaContest.findOne({
    _id: contestId, kind: 'scheduled', platform: { $in: ['codeforces', 'leetcode'] },
    endTime: { $lte: new Date(observedAt.getTime() - CONTEST_RATING_DELAY_MS) },
  }).lean();
  if (!contest || !contest.externalId || !contest.startTime) return { changed: 0, failed: 0 };
  const platform = contest.platform as 'codeforces' | 'leetcode';
  const handleField = platform === 'codeforces' ? 'platforms.codeforces.handle' : 'platforms.leetcode.username';
  const settingsFilter = { [handleField]: { $type: 'string', $regex: /\S/ } };
  if (!await UserSettings.exists(settingsFilter)) return { changed: 0, failed: 0 };
  await DsaContestParticipation.init();
  const standings = platform === 'codeforces' ? await fetchCodeforcesResults(contest.externalId) : null;
  let changed = 0;
  let failed = 0;
  for await (const settings of UserSettings.find(settingsFilter).select('userId platforms').cursor()) {
    const userId = settings.userId.toString();
    const rawHandle = platform === 'codeforces' ? settings.platforms.codeforces.handle : settings.platforms.leetcode.username;
    const handle = rawHandle?.trim();
    if (!handle || handle.length > 128) continue;
    try {
      const result = standings ? standings.get(handle.toLowerCase()) ?? null : await fetchLeetcodeResult(handle, contest.startTime);
      if (!result) continue; // Never manufacture a participation for a nonparticipant.
      if (!await UserSettings.exists({ _id: settings._id, userId, [handleField]: rawHandle })) continue;
      const key = { userId: new Types.ObjectId(userId), contestId: contest._id };
      const existing = await DsaContestParticipation.findOne(key).lean();
      const values: ContestResult & { handle: string } = { ...result, handle };
      if (existing?.handle.toLowerCase() === handle.toLowerCase() && existing.ratingAfter != null && values.ratingAfter === null) {
        values.ratingBefore = existing.ratingBefore ?? null;
        values.ratingAfter = existing.ratingAfter ?? null;
        values.ratingChange = existing.ratingChange ?? null;
      }
      let before;
      try {
        before = await DsaContestParticipation.findOneAndUpdate({
          ...key, $or: [{ observedAt: { $lte: observedAt } }, { observedAt: { $exists: false } }],
        }, { $set: { ...values, platform, observedAt } }, { upsert: true, returnDocument: 'before', runValidators: true }).lean();
      } catch (error) {
        // A concurrent insert/newer observation won the unique key. The next
        // hourly reconciliation can refresh it; an old request must not overwrite it.
        if ((error as { code?: number }).code === 11000) continue;
        throw error;
      }
      if (before && resultFields.every(field => before[field] === values[field])) continue;
      changed++;
      try {
        await eventBus.publishEnvelope(userId, 'contest.rating_updated', {
          contestId, platform, ...values,
        });
      } catch {
        logger.warn('[contest-rating] SSE delivery failed after participation save', { userId, contestId });
      }
    } catch (error) {
      if (error instanceof ContestProviderRateLimit) throw error;
      failed++;
      logger.warn('[contest-rating] User result synchronization failed', { userId, contestId });
    }
  }
  if (failed) throw new Error(`Contest rating synchronization failed for ${failed} users`);
  return { changed, failed };
}
