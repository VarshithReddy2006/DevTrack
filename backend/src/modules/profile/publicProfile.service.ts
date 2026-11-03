import { PublicProfile } from '../../db/models/publicProfile.model.js';
import { User } from '../../db/models/user.model.js';
import { PlatformStats } from '../../db/models/platformStats.model.js';
import { DsaProblem } from '../../db/models/dsaProblem.model.js';
import { VerifiedProject } from '../../db/models/verifiedProject.model.js';
import { UserXp } from '../../db/models/userXp.model.js';
import { UserStreakLog } from '../../db/models/userStreakLog.model.js';
import { ProfileView } from '../../db/models/profileView.model.js';
import { VerificationEngine } from './verification.engine.js';
import mongoose from 'mongoose';
import { escapeRegExp } from '../../shared/regex.js';

export class PublicProfileService {
  /**
   * Recompute the public profile snapshot for a user based on verified signals.
   */
  static async computeProfile(userId: mongoose.Types.ObjectId | string): Promise<void> {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    // Run basic verification
    const verificationScore = await VerificationEngine.evaluateTrustScore(userId);
    
    // Aggregation (stubs - in real app, these would query the actual signals)
    const githubStats = await PlatformStats.findOne({ userId, platform: 'github' });
    const leetcodeStats = await PlatformStats.findOne({ userId, platform: 'leetcode' });
    const codeforcesStats = await PlatformStats.findOne({ userId, platform: 'codeforces' });
    
    // Get verified projects
    const projects = await VerifiedProject.find({ userId, 'verification.status': 'verified' });
    
    // Get XP
    const xp = await UserXp.findOne({ userId });

    const computedSnapshot = {
      computedAt: new Date(),
      version: 1,
      identity: {
        displayName: user.displayName || user.username,
        avatarUrl: null,
        joinedAt: user.joinedAt,
        timezone: user.timezone || 'UTC',
        level: xp?.currentLevel || 1,
        levelName: 'Engineer',
        totalXp: xp?.totalXp || 0,
      },
      consistency: {
        currentStreak: xp?.lifetimeStats?.dailyStreaks || 0,
        longestStreak: xp?.lifetimeStats?.longestStreak || 0,
        activeDaysLast30: 0,
        activeDaysLast90: 0,
        activeDaysLast365: 0,
        weeklyConsistencyScore: 0,
        monthlyConsistencyScore: 0,
        // Recruiter Interpretation:
        recruiterSignal: (xp?.lifetimeStats?.longestStreak || 0) > 30 ? "Demonstrates highly consistent engineering habit and long-term project execution." : null,
      },
      dsa: {
        totalSolved: (leetcodeStats?.totalSolved || 0) + (codeforcesStats?.totalSolved || 0),
        easySolved: leetcodeStats?.easySolved || 0,
        mediumSolved: leetcodeStats?.mediumSolved || 0,
        hardSolved: leetcodeStats?.hardSolved || 0,
        difficultyRatio: 0, // Compute based on hard / total
        topicsCovered: [],
        contestsParticipated: 0,
        bestContestRating: null,
        platformBreakdown: [
          { platform: 'leetcode', solved: leetcodeStats?.totalSolved || 0, rating: leetcodeStats?.rating || null },
          { platform: 'codeforces', solved: codeforcesStats?.totalSolved || 0, rating: codeforcesStats?.rating || null },
        ],
        // Recruiter Interpretation:
        recruiterSignal: (leetcodeStats?.hardSolved || 0) > 50 ? "Proficient in complex algorithm design and advanced data structures." : null,
      },
      github: {
        isVerified: !!githubStats,
        totalContributions: (githubStats?.rawData?.total_contributions as number) || 0,
        contributionsLast365: 0,
        longestContribStreak: 0,
        verifiedProjectCount: projects.length,
        primaryLanguages: [],
        totalCommits: (githubStats?.rawData?.total_commits as number) || 0,
        totalPRs: (githubStats?.rawData?.total_prs as number) || 0,
        // Recruiter Interpretation:
        recruiterSignal: projects.length > 2 ? "Proven ability to deliver end-to-end verified projects." : null,
      },
      projects: projects.map((p) => p.toJSON()),
      achievements: [],
      activityHeatmap: {
        year: new Date().getFullYear(),
        weeks: [],
      },
      velocityIndicators: {
        solveVelocity30d: 0,
        commitVelocity30d: 0,
        xpVelocity30d: 0,
        trend: 'inactive' as const,
        recruiterSignal: "Steady engineering momentum.", // Default for now
      },
    };

    const profileData = {
      userId,
      username: user.username,
      slug: user.username.toLowerCase(),
      snapshot: computedSnapshot,
      antiGaming: {
        suspicionScore: verificationScore.suspicionScore,
        flags: verificationScore.flags,
        lastAuditedAt: new Date(),
        isFlagged: verificationScore.suspicionScore > 70,
      },
      seo: {
        ogTitle: `${user.username} | Verified Engineering Profile`,
        ogDescription: `View ${user.username}'s verified engineering metrics, projects, and proof of work on DevTrack.`,
        ogImageUrl: null,
        canonicalUrl: `https://devtrack.io/u/${user.username.toLowerCase()}`,
      },
    };

    await PublicProfile.findOneAndUpdate(
      { userId },
      { $set: profileData },
      { upsert: true, new: true }
    );
  }

  /**
   * Get a public profile by username
   */
  static async getPublicProfileByUsername(username: string, viewerIp: string, viewerType: 'public' | 'recruiter' | 'authenticated', viewerUserId?: mongoose.Types.ObjectId) {
    let profile = await PublicProfile.findOne({ slug: username.toLowerCase() });
    
    // If not found, check if user exists and create basic profile
    if (!profile) {
      const user = await User.findOne({ username: new RegExp(`^${escapeRegExp(username)}$`, 'i') });
      if (!user) throw new Error('Profile not found');
      
      await this.computeProfile(user._id as mongoose.Types.ObjectId);
      profile = await PublicProfile.findOne({ slug: user.username.toLowerCase() });
    }

    if (profile) {
      // Track view asynchronously
      ProfileView.create({
        profileUserId: profile.userId,
        viewerType,
        viewerUserId: viewerUserId || null,
        viewerIp,
      }).catch(err => console.error('Error tracking profile view:', err));

      // Update stats on profile (can be debounced in prod)
      await PublicProfile.updateOne(
        { _id: profile._id },
        { 
          $inc: { 
            'stats.profileViews': viewerType === 'public' ? 1 : 0,
            'stats.recruiterViews': viewerType === 'recruiter' ? 1 : 0,
          },
          $set: { 'stats.lastViewedAt': new Date() }
        }
      );
    }

    return profile;
  }
}
