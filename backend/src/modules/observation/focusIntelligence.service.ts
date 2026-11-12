import { createLocalHourReader } from '../../shared/date.js';
import { getUserTimezone } from '../../shared/userTimezone.js';
import { FocusSession } from '../../db/models/focusSession.model.js';

export interface FocusAnalytics {
  effectivenessScore: number;
  interruptionRate: number;
  deepWorkConsistency: number;
  bestSessionDuration: number;
  mostConsistentTimeOfDay: string;
  distractionTrend: 'improving' | 'worsening' | 'stable';
  coachingInsights: string[];
}

export class FocusIntelligenceService {
  static async analyzeUserFocus(userId: string): Promise<FocusAnalytics> {
    const sessions = await FocusSession.find({ userId, status: 'completed' })
      .sort({ startedAt: -1 })
      .limit(50)
      .lean();

    if (sessions.length === 0) {
      return {
        effectivenessScore: 0,
        interruptionRate: 0,
        deepWorkConsistency: 0,
        bestSessionDuration: 0,
        mostConsistentTimeOfDay: 'Unknown',
        distractionTrend: 'stable',
        coachingInsights: ['Complete your first focus session to get insights.'],
      };
    }

    const totalDuration = sessions.reduce((acc, s) => acc + (s.actualDurationMinutes || 0), 0);
    const totalDistractions = sessions.reduce((acc, s) => acc + (s.distractionEvents || 0), 0);
    const interruptionRate = totalDuration > 0 ? (totalDistractions / totalDuration) * 60 : 0;

    const avgQuality = sessions.reduce((acc, s) => acc + (s.focusQualityScore || 0), 0) / sessions.length;
    const effectivenessScore = Math.round(avgQuality);

    const deepWorkSessions = sessions.filter(s => (s.actualDurationMinutes || 0) >= 60 && (s.focusQualityScore || 0) > 75);
    const deepWorkConsistency = Math.round((deepWorkSessions.length / sessions.length) * 100);

    const qualityByDuration: Record<number, { score: number, count: number }> = {};
    for (const s of sessions) {
      const dur = s.plannedDurationMinutes || 0;
      if (!qualityByDuration[dur]) qualityByDuration[dur] = { score: 0, count: 0 };
      qualityByDuration[dur].score += s.focusQualityScore || 0;
      qualityByDuration[dur].count += 1;
    }

    let bestSessionDuration = 0;
    let maxAvgQuality = -1;
    for (const dur in qualityByDuration) {
      const avg = qualityByDuration[dur].score / qualityByDuration[dur].count;
      if (avg > maxAvgQuality && qualityByDuration[dur].count >= 2) {
        maxAvgQuality = avg;
        bestSessionDuration = parseInt(dur);
      }
    }

    const timeOfDayCounts: Record<string, { count: number, quality: number }> = {
      'Morning': { count: 0, quality: 0 },
      'Afternoon': { count: 0, quality: 0 },
      'Evening': { count: 0, quality: 0 },
      'Night': { count: 0, quality: 0 },
    };

    const readLocalHour = createLocalHourReader(await getUserTimezone(userId));
    for (const s of sessions) {
      const hour = readLocalHour(s.startedAt);
      let time = '';
      if (hour >= 5 && hour < 12) time = 'Morning';
      else if (hour >= 12 && hour < 17) time = 'Afternoon';
      else if (hour >= 17 && hour < 22) time = 'Evening';
      else time = 'Night';

      timeOfDayCounts[time].count++;
      timeOfDayCounts[time].quality += s.focusQualityScore || 0;
    }

    let mostConsistentTimeOfDay = 'Unknown';
    let bestTimeQuality = -1;
    for (const time in timeOfDayCounts) {
      if (timeOfDayCounts[time].count > 0) {
        const avg = timeOfDayCounts[time].quality / timeOfDayCounts[time].count;
        if (avg > bestTimeQuality) {
          bestTimeQuality = avg;
          mostConsistentTimeOfDay = time;
        }
      }
    }

    let distractionTrend: 'improving' | 'worsening' | 'stable' = 'stable';
    if (sessions.length >= 10) {
      const recent = sessions.slice(0, 5).reduce((acc, s) => acc + (s.distractionEvents || 0), 0) / 5;
      const past = sessions.slice(5, 10).reduce((acc, s) => acc + (s.distractionEvents || 0), 0) / 5;
      if (recent > past * 1.2) distractionTrend = 'worsening';
      else if (recent < past * 0.8) distractionTrend = 'improving';
    }

    const coachingInsights: string[] = [];
    if (bestSessionDuration > 0 && maxAvgQuality > 70) {
      coachingInsights.push(`${bestSessionDuration}-minute sessions produce your highest-quality work.`);
    }
    if (distractionTrend === 'worsening') {
      coachingInsights.push('You lose focus fastest after rapid task switching. Try minimizing open tabs.');
    } else if (distractionTrend === 'improving') {
      coachingInsights.push('Your focus quality is improving as distraction rates drop.');
    }
    if (mostConsistentTimeOfDay !== 'Unknown') {
      coachingInsights.push(`${mostConsistentTimeOfDay} sessions are your most consistent.`);
    }

    return {
      effectivenessScore,
      interruptionRate,
      deepWorkConsistency,
      bestSessionDuration,
      mostConsistentTimeOfDay,
      distractionTrend,
      coachingInsights,
    };
  }
}
