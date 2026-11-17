import { IPublicProfile } from '../../db/models/publicProfile.model.js';
import { IProfileTimelineEvent } from '../../db/models/profileTimelineEvent.model.js';

import type { IUserSettings } from '../../db/models/userSettings.model.js';

export function mapToPublicProfileDTO(profile: IPublicProfile, privacy?: Partial<IUserSettings['privacy']>) {
  const snapshot = profile.snapshot;
  // A section needs the owner's publication opt-in and must not be switched off in privacy settings.
  const { sections } = profile;
  const showStreak = sections?.streak === true && privacy?.showStreak !== false;
  const showGithub = sections?.github === true && privacy?.showGithub !== false;
  const showDsa = sections?.dsa === true && privacy?.showDsaProgress !== false;
  const showProjects = sections?.projects === true && privacy?.showProjects !== false;
  const showActivity = sections?.activity === true && privacy?.showActivity !== false;
  // Badges are derived from the activity counters the anti-gaming audit distrusts, so hide them while flagged.
  const underReview = profile.antiGaming?.isFlagged === true;

  return {
    username: profile.username,
    visibility: profile.visibility,
    isIndexable: profile.isIndexable,
    identity: {
      displayName: snapshot.identity.displayName,
      avatarUrl: snapshot.identity.avatarUrl,
      joinedAt: snapshot.identity.joinedAt,
      timezone: snapshot.identity.timezone,
      levelName: snapshot.identity.levelName,
    },
    consistency: showStreak ? {
      currentStreak: snapshot.consistency.currentStreak,
      longestStreak: snapshot.consistency.longestStreak,
      activeDaysLast30: showActivity ? snapshot.consistency.activeDaysLast30 : undefined,
      activeDaysLast90: showActivity ? snapshot.consistency.activeDaysLast90 : undefined,
      activeDaysLast365: showActivity ? snapshot.consistency.activeDaysLast365 : undefined,
      weeklyConsistencyScore: showActivity ? snapshot.consistency.weeklyConsistencyScore : undefined,
      monthlyConsistencyScore: showActivity ? snapshot.consistency.monthlyConsistencyScore : undefined,
    } : undefined,
    dsa: showDsa ? {
      totalSolved: snapshot.dsa.totalSolved,
      difficultyRatio: snapshot.dsa.difficultyRatio,
      topicsCovered: snapshot.dsa.topicsCovered,
      contestsParticipated: snapshot.dsa.contestsParticipated,
      bestContestRating: snapshot.dsa.bestContestRating,
      platformBreakdown: snapshot.dsa.platformBreakdown.map(({ platform, solved }) => ({ platform, solved })),
    } : undefined,
    github: showGithub ? {
      isVerified: snapshot.github.isVerified,
      verifiedProjectCount: showProjects ? snapshot.github.verifiedProjectCount : undefined,
      totalContributions: snapshot.github.totalContributions,
      contributionsLast365: snapshot.github.contributionsLast365,
      primaryLanguages: snapshot.github.primaryLanguages,
      totalCommits: snapshot.github.totalCommits,
      totalPRs: snapshot.github.totalPRs,
    } : undefined,
    projects: showProjects ? snapshot.projects : [],
    trust: { underReview },
    achievements: underReview ? [] : snapshot.achievements.filter(({ category }) => {
      if (category === 'streak') return showStreak;
      if (category === 'projects') return showProjects;
      if (category === 'problems' || category === 'contest') return showDsa;
      return showStreak && showDsa && showProjects;
    }).map(({ id, name, icon, rarity, unlockedAt }) => ({ id, name, icon, rarity, unlockedAt })),
    activityHeatmap: showActivity ? snapshot.activityHeatmap : undefined,
    velocityIndicators: showActivity ? {
      solveVelocity30d: showDsa ? snapshot.velocityIndicators.solveVelocity30d : undefined,
      commitVelocity30d: showGithub ? snapshot.velocityIndicators.commitVelocity30d : undefined,
      xpVelocity30d: showStreak && showDsa && showGithub && showProjects ? snapshot.velocityIndicators.xpVelocity30d : undefined,
      trend: showStreak && showDsa && showGithub && showProjects ? snapshot.velocityIndicators.trend : undefined,
    } : undefined,
    seo: profile.seo,
  };
}

export type PublicProfileDTO = ReturnType<typeof mapToPublicProfileDTO>;

export interface PublicTimelineDTO {
  id: string;
  eventType: string;
  title: string;
  description: string;
  eventDate: Date;
}

export function mapToPublicTimelineDTO(events: IProfileTimelineEvent[]): PublicTimelineDTO[] {
  return events.map(e => ({
    id: e._id.toString(),
    eventType: e.eventType,
    title: e.title,
    description: e.description,
    eventDate: e.eventDate,
  }));
}
