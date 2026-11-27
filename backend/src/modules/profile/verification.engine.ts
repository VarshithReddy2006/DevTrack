import mongoose from 'mongoose';
import { User } from '../../db/models/user.model.js';
import { UserXp } from '../../db/models/userXp.model.js';
import { PlatformStats } from '../../db/models/platformStats.model.js';
import { VerifiedProject } from '../../db/models/verifiedProject.model.js';
import { XpTransaction } from '../../db/models/xpTransaction.model.js';

/** Suspicion score above which a profile is flagged and its unverified badges are hidden. */
export const SUSPICION_FLAG_THRESHOLD = 70;

const MINUTE_MS = 60_000;
/** How far back the XP velocity check reads the ledger. */
export const XP_VELOCITY_LOOKBACK_MS = 7 * 24 * 60 * MINUTE_MS;
/** Upper bound on ledger rows read per user, so one runaway account cannot blow up a sweep. */
const XP_VELOCITY_MAX_ROWS = 20_000;
/** Bulk credits (a platform sync pays for every new solve at once, admin grants) say nothing about pace. */
export const XP_VELOCITY_IGNORED_SOURCES = ['sync_completed', 'manual'];

export const XP_BURST_WINDOW_MS = 10 * MINUTE_MS;
export const XP_BURST_LIMIT = 2_000;
export const XP_SUSTAINED_WINDOW_MS = 60 * MINUTE_MS;
export const XP_SUSTAINED_LIMIT = 1_000;

/**
 * Largest XP total earned inside any sliding window of `windowMs`.
 * `events` must be sorted by time ascending. Two pointers, so O(n).
 */
export function maxXpInWindow(events: { at: number; xp: number }[], windowMs: number): number {
  let best = 0;
  let sum = 0;
  let start = 0;
  for (const { at, xp } of events) {
    sum += xp;
    while (at - events[start].at > windowMs) sum -= events[start++].xp;
    if (sum > best) best = sum;
  }
  return best;
}

export class VerificationEngine {
  /**
   * Evaluates the trust score of a user based on account age, activity, and verified links.
   * Returns a trustScore from 0 to 1000, and a list of flags.
   */
  static async evaluateTrustScore(userId: mongoose.Types.ObjectId | string): Promise<{ trustScore: number; flags: string[]; suspicionScore: number }> {
    const user = await User.findById(userId);
    if (!user) return { trustScore: 0, flags: [], suspicionScore: 0 };

    let trustScore = 0;
    let suspicionScore = 0;
    const flags: string[] = [];

    // 1. Account Age (Max 200 pts, scales to 1 year)
    const ageInDays = (Date.now() - user.joinedAt.getTime()) / (1000 * 60 * 60 * 24);
    trustScore += Math.min(200, (ageInDays / 365) * 200);

    // 2. Consistency & Activity (Max 400 pts)
    const xp = await UserXp.findOne({ userId });
    if (xp) {
      // Level contribution (max 200)
      trustScore += Math.min(200, xp.currentLevel * 10);
      
      // Streaks contribution (max 200)
      const maxStreak = xp.lifetimeStats?.longestStreak || 0;
      trustScore += Math.min(200, (maxStreak / 30) * 200); // 30 days streak gives max pts
    }

    // 3. GitHub Authenticity (Max 400 pts)
    const githubStats = await PlatformStats.findOne({ userId, platformName: 'github' });
    if (githubStats && githubStats.rawData) {
      const raw = githubStats.rawData as any;
      const commits = raw.total_commits || 0;
      const repos = raw.public_repos || 0;
      
      if (repos > 0) {
        trustScore += Math.min(100, repos * 10);
      }
      if (commits > 50) {
        trustScore += Math.min(300, (commits / 500) * 300);
      }

      // Anomaly checks on GitHub
      if (commits > 1000 && repos <= 1) {
        suspicionScore += 50;
        flags.push('high_commit_low_repo_ratio');
      }
    }

    // 4. Solve Farming Heuristics (DSA)
    const leetcodeStats = await PlatformStats.findOne({ userId, platformName: 'leetcode' }).lean();
    if (leetcodeStats) {
      const raw = leetcodeStats.rawData;
      const totalSolved = leetcodeStats.totalSolved ?? (typeof raw?.totalSolved === 'number' ? raw.totalSolved : 0);
      const hardSolved = leetcodeStats.hardSolved ?? (typeof raw?.hardSolved === 'number' ? raw.hardSolved : 0);

      // Impossible velocity heuristic
      // In a real app we'd look at DailyActivity, but here we approximate based on joinedAt vs total solved
      if (ageInDays < 3 && totalSolved > 500) {
        suspicionScore += 80;
        flags.push('impossible_solve_velocity');
      }
      if (hardSolved > totalSolved * 0.8 && totalSolved > 50) {
        suspicionScore += 40;
        flags.push('suspicious_difficulty_ratio');
      }
    }

    // 5. XP velocity (sliding windows over the XP ledger)
    const xpRows = await XpTransaction.find({
      userId,
      createdAt: { $gte: new Date(Date.now() - XP_VELOCITY_LOOKBACK_MS) },
      sourceType: { $nin: XP_VELOCITY_IGNORED_SOURCES },
      xpAwarded: { $gt: 0 },
    }).sort({ createdAt: 1 }).limit(XP_VELOCITY_MAX_ROWS).select('createdAt xpAwarded').lean();
    const xpEvents = xpRows.map(row => ({ at: row.createdAt.getTime(), xp: row.xpAwarded }));

    const burst = maxXpInWindow(xpEvents, XP_BURST_WINDOW_MS) > XP_BURST_LIMIT;
    const sustained = !burst && maxXpInWindow(xpEvents, XP_SUSTAINED_WINDOW_MS) > XP_SUSTAINED_LIMIT
      // Fast XP is believable next to verified project work, so only count it when there is none.
      && !await VerifiedProject.exists({ userId, 'verification.status': 'verified', 'provenance.source': { $exists: false } });
    if (burst || sustained) {
      suspicionScore += 80;
      flags.push('abnormal_xp_velocity');
    }

    // Final calculations
    trustScore = Math.max(0, Math.min(1000, trustScore - (suspicionScore * 5))); // Penalize trust based on suspicion

    return { trustScore: Math.round(trustScore), suspicionScore, flags };
  }
}
