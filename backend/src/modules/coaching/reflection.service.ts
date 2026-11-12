import { FocusSession } from '../../db/models/focusSession.model.js';
import { UserDailyChallenge } from '../../db/models/userDailyChallenge.model.js';
import { localDateString, localDayBounds } from '../../shared/date.js';
import { getUserTimezone } from '../../shared/userTimezone.js';

export class ReflectionService {
  static async generateWeeklyReflection(userId: string) {
    const timezone = await getUserTimezone(userId);
    const today = localDateString(new Date(), timezone);
    // Shift the calendar date in UTC, then resolve that date's midnight in the user's zone.
    const cutoffDate = new Date(`${today}T00:00:00Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 7);
    const { start: oneWeekAgo } = localDayBounds(cutoffDate.toISOString().slice(0, 10), timezone);

    const sessions = await FocusSession.find({ 
      userId, 
      startedAt: { $gte: oneWeekAgo },
      status: 'completed'
    }).lean();

    const challenges = await UserDailyChallenge.find({
      userId,
      completedAt: { $gte: oneWeekAgo }
    }).lean();

    const summaries: string[] = [];

    if (challenges.length > 0) {
      summaries.push(`This week you completed ${challenges.length} daily challenges.`);
    }

    const totalFocusMinutes = sessions.reduce((acc, s) => acc + (s.actualDurationMinutes || 0), 0);
    if (totalFocusMinutes > 0) {
      const hours = (totalFocusMinutes / 60).toFixed(1);
      summaries.push(`You spent ${hours} hours in deep focus.`);
    }

    const avgQuality = sessions.length > 0 
      ? sessions.reduce((acc, s) => acc + (s.focusQualityScore || 0), 0) / sessions.length 
      : 0;

    if (avgQuality > 80) {
      summaries.push(`Your focus quality was excellent this week!`);
    } else if (avgQuality > 0) {
      summaries.push(`Focus quality was stable, but there's room to minimize distractions.`);
    }

    return {
      period: 'weekly',
      summaries,
      totalFocusMinutes,
      completedChallenges: challenges.length,
      averageFocusQuality: Math.round(avgQuality)
    };
  }
}
