import { FocusSession } from '../../db/models/focusSession.model.js';
import { createLocalHourReader, localDateString } from '../../shared/date.js';
import { getUserTimezone } from '../../shared/userTimezone.js';

export class CoachingService {
  /**
   * Generates heuristic coaching insights based on user focus history.
   */
  static async generateCoachingInsights(userId: string) {
    const sessions = await FocusSession.find({ userId, status: 'completed' })
      .sort({ startedAt: -1 })
      .limit(20)
      .lean();

    const insights: string[] = [];

    if (sessions.length === 0) {
      return ["Try starting your first focus session to get personalized insights!"];
    }

    // Heuristic 1: Optimal duration
    const qualityByDuration: Record<number, { score: number, count: number }> = {};
    for (const session of sessions) {
      const dur = session.plannedDurationMinutes;
      if (!qualityByDuration[dur]) qualityByDuration[dur] = { score: 0, count: 0 };
      qualityByDuration[dur].score += session.focusQualityScore || 0;
      qualityByDuration[dur].count += 1;
    }

    let bestDuration = 0;
    let maxAvgQuality = -1;
    for (const dur in qualityByDuration) {
      const avg = qualityByDuration[dur].score / qualityByDuration[dur].count;
      if (avg > maxAvgQuality && qualityByDuration[dur].count > 1) {
        maxAvgQuality = avg;
        bestDuration = parseInt(dur);
      }
    }

    if (bestDuration > 0 && maxAvgQuality > 70) {
      insights.push(`${bestDuration}-minute sessions produce your highest-quality work.`);
    }

    // Heuristic 2: Distraction analysis
    const recentDistractions = sessions.slice(0, 5).reduce((acc, s) => acc + (s.distractionEvents || 0), 0);
    if (recentDistractions > 15) {
      insights.push("You lose focus fastest after rapid task switching. Try minimizing open tabs.");
    }

    // Heuristic 3: Consistency
    const abandoned = await FocusSession.countDocuments({ userId, status: 'abandoned' });
    if (abandoned > 5) {
      insights.push("You've abandoned a few sessions lately. Try shorter intervals to rebuild momentum.");
    } else {
      insights.push("Your focus consistency is strong. Keep it up!");
    }

    return insights;
  }

  /**
   * Detects emotional state based on recent activity.
   */
  static async detectEmotionalState(userId: string) {
    const recentSessions = await FocusSession.find({ userId })
      .sort({ startedAt: -1 })
      .limit(10)
      .lean();

    const abandonedCount = recentSessions.filter(s => s.status === 'abandoned').length;
    const avgQuality = recentSessions.reduce((acc, s) => acc + (s.focusQualityScore || 0), 0) / (recentSessions.length || 1);

    if (abandonedCount >= 3 || (recentSessions.length > 5 && avgQuality < 40)) {
      return 'burnout_risk';
    }

    const timezone = await getUserTimezone(userId);
    const now = new Date();
    const localToday = localDateString(now, timezone);
    const activeToday = recentSessions.some(session => localDateString(session.startedAt, timezone) === localToday);

    if (!activeToday && createLocalHourReader(timezone)(now) >= 20) {
      return 'streak_risk';
    }

    if (avgQuality > 80 && recentSessions.length > 3) {
      return 'high_momentum';
    }

    return 'calm';
  }
}
