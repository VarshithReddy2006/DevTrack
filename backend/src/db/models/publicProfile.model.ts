import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IPublicProfile extends Document {
  userId: Types.ObjectId;
  username: string;
  slug: string;
  visibility: 'public' | 'private' | 'recruiter_only';
  isIndexable: boolean;

  snapshot: {
    computedAt: Date;
    version: number;

    identity: {
      displayName: string;
      avatarUrl: string | null;
      joinedAt: Date;
      timezone: string;
      level: number;
      levelName: string;
      totalXp: number;
    };

    consistency: {
      currentStreak: number;
      longestStreak: number;
      activeDaysLast30: number;
      activeDaysLast90: number;
      activeDaysLast365: number;
      weeklyConsistencyScore: number;
      monthlyConsistencyScore: number;
    };

    dsa: {
      totalSolved: number;
      easySolved: number;
      mediumSolved: number;
      hardSolved: number;
      difficultyRatio: number;
      topicsCovered: string[];
      contestsParticipated: number;
      bestContestRating: number | null;
      platformBreakdown: {
        platform: string;
        solved: number;
        rating: number | null;
      }[];
    };

    github: {
      isVerified: boolean;
      totalContributions: number;
      contributionsLast365: number;
      longestContribStreak: number;
      verifiedProjectCount: number;
      primaryLanguages: string[];
      totalCommits: number;
      totalPRs: number;
    };

    projects: any[]; // VerifiedProjectSnapshot array

    achievements: {
      id: string;
      name: string;
      icon: string;
      rarity: 'common' | 'rare' | 'epic' | 'legendary';
      unlockedAt: Date;
      category?: string;
    }[];

    activityHeatmap: {
      year: number;
      weeks: { date: string; count: number; level: 0 | 1 | 2 | 3 | 4 }[];
    };

    velocityIndicators: {
      solveVelocity30d: number;
      commitVelocity30d: number;
      xpVelocity30d: number;
      trend: 'accelerating' | 'steady' | 'decelerating' | 'inactive';
    };
  };

  antiGaming: {
    suspicionScore: number;
    flags: string[];
    lastAuditedAt: Date | null;
    isFlagged: boolean;
  };

  seo: {
    ogTitle: string;
    ogDescription: string;
    ogImageUrl: string | null;
    canonicalUrl: string;
  };

  stats: {
    profileViews: number;
    recruiterViews: number;
    lastViewedAt: Date | null;
  };

  createdAt: Date;
  updatedAt: Date;
}

const PublicProfileSchema = new Schema<IPublicProfile>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    username: { type: String, required: true, unique: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    visibility: { type: String, enum: ['public', 'private', 'recruiter_only'], default: 'public' },
    isIndexable: { type: Boolean, default: true },

    snapshot: {
      computedAt: { type: Date, default: Date.now },
      version: { type: Number, default: 1 },

      identity: {
        displayName: { type: String, default: '' },
        avatarUrl: { type: String, default: null },
        joinedAt: { type: Date, default: Date.now },
        timezone: { type: String, default: 'UTC' },
        level: { type: Number, default: 1 },
        levelName: { type: String, default: 'Novice' },
        totalXp: { type: Number, default: 0 },
      },

      consistency: {
        currentStreak: { type: Number, default: 0 },
        longestStreak: { type: Number, default: 0 },
        activeDaysLast30: { type: Number, default: 0 },
        activeDaysLast90: { type: Number, default: 0 },
        activeDaysLast365: { type: Number, default: 0 },
        weeklyConsistencyScore: { type: Number, default: 0 },
        monthlyConsistencyScore: { type: Number, default: 0 },
      },

      dsa: {
        totalSolved: { type: Number, default: 0 },
        easySolved: { type: Number, default: 0 },
        mediumSolved: { type: Number, default: 0 },
        hardSolved: { type: Number, default: 0 },
        difficultyRatio: { type: Number, default: 0 },
        topicsCovered: [{ type: String }],
        contestsParticipated: { type: Number, default: 0 },
        bestContestRating: { type: Number, default: null },
        platformBreakdown: [
          {
            platform: { type: String },
            solved: { type: Number },
            rating: { type: Number, default: null },
          },
        ],
      },

      github: {
        isVerified: { type: Boolean, default: false },
        totalContributions: { type: Number, default: 0 },
        contributionsLast365: { type: Number, default: 0 },
        longestContribStreak: { type: Number, default: 0 },
        verifiedProjectCount: { type: Number, default: 0 },
        primaryLanguages: [{ type: String }],
        totalCommits: { type: Number, default: 0 },
        totalPRs: { type: Number, default: 0 },
      },

      projects: [{ type: Schema.Types.Mixed }],

      achievements: [
        {
          id: { type: String },
          name: { type: String },
          icon: { type: String },
          rarity: { type: String, enum: ['common', 'rare', 'epic', 'legendary'] },
          unlockedAt: { type: Date },
          category: { type: String },
        },
      ],

      activityHeatmap: {
        year: { type: Number, default: new Date().getFullYear() },
        weeks: [
          {
            date: { type: String },
            count: { type: Number },
            level: { type: Number, enum: [0, 1, 2, 3, 4] },
          },
        ],
      },

      velocityIndicators: {
        solveVelocity30d: { type: Number, default: 0 },
        commitVelocity30d: { type: Number, default: 0 },
        xpVelocity30d: { type: Number, default: 0 },
        trend: { type: String, enum: ['accelerating', 'steady', 'decelerating', 'inactive'], default: 'inactive' },
      },
    },

    antiGaming: {
      suspicionScore: { type: Number, default: 0 },
      flags: [{ type: String }],
      lastAuditedAt: { type: Date, default: null },
      isFlagged: { type: Boolean, default: false },
    },

    seo: {
      ogTitle: { type: String, default: '' },
      ogDescription: { type: String, default: '' },
      ogImageUrl: { type: String, default: null },
      canonicalUrl: { type: String, default: '' },
    },

    stats: {
      profileViews: { type: Number, default: 0 },
      recruiterViews: { type: Number, default: 0 },
      lastViewedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

PublicProfileSchema.index({ visibility: 1, isIndexable: 1 });
PublicProfileSchema.index({ 'antiGaming.isFlagged': 1 });
PublicProfileSchema.index({ 'snapshot.computedAt': -1 });

export const PublicProfile = mongoose.model<IPublicProfile>('PublicProfile', PublicProfileSchema);
