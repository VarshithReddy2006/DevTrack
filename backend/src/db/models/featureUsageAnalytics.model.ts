// src/db/models/featureUsageAnalytics.model.ts — Feature Discovery and Usage Analytics
// Tracks feature adoption, retention, and value scoring

import mongoose, { Schema, type Document } from 'mongoose';

export interface IFeatureUsageAnalytics extends Document {
  featureName: string;
  featureCategory: string;

  // Discovery metrics
  totalDiscoveries: number;
  uniqueUsersDiscovered: number;
  discoveryRate: number;

  // Usage metrics
  totalUses: number;
  uniqueUsers: number;
  averageUsagePerUser: number;
  usageFrequency: 'daily' | 'weekly' | 'monthly' | 'rarely';

  // Retention metrics
  firstUseRetention: number; // % of users who used again within 7 days
  thirtyDayRetention: number; // % of users still using after 30 days
  repeatUsageRate: number; // % of users who used more than once

  // Engagement quality
  averageTimeSpent: number;
  completionRate: number;
  errorRate: number;
  satisfactionScore: number;

  // Value scoring
  featureValueScore: number; // 0-100 composite score
  businessImpact: 'critical' | 'high' | 'medium' | 'low' | 'unknown';

  // Usage patterns
  peakUsageTimes: Array<{
    hour: number;
    dayOfWeek: number;
    usageCount: number;
  }>;

  // User segments
  userSegments: Array<{
    segment: string;
    usageCount: number;
    retentionRate: number;
  }>;

  // Ignored features
  ignoreRate: number; // % of users who discovered but never used
  abandonmentRate: number; // % of users who stopped using

  // Correlations
  correlatedFeatures: Array<{
    featureName: string;
    correlation: number;
  }>;

  // Metadata
  firstSeen: Date;
  lastUpdated: Date;

  createdAt: Date;
  updatedAt: Date;
}

const featureUsageAnalyticsSchema = new Schema<IFeatureUsageAnalytics>(
  {
    featureName: { type: String, required: true, unique: true },
    featureCategory: { type: String, required: true, index: true },

    // Discovery metrics
    totalDiscoveries: { type: Number, default: 0 },
    uniqueUsersDiscovered: { type: Number, default: 0 },
    discoveryRate: { type: Number, default: 0, min: 0, max: 100 },

    // Usage metrics
    totalUses: { type: Number, default: 0 },
    uniqueUsers: { type: Number, default: 0 },
    averageUsagePerUser: { type: Number, default: 0 },
    usageFrequency: { type: String, enum: ['daily', 'weekly', 'monthly', 'rarely'], default: 'rarely' },

    // Retention metrics
    firstUseRetention: { type: Number, default: 0, min: 0, max: 100 },
    thirtyDayRetention: { type: Number, default: 0, min: 0, max: 100 },
    repeatUsageRate: { type: Number, default: 0, min: 0, max: 100 },

    // Engagement quality
    averageTimeSpent: { type: Number, default: 0 },
    completionRate: { type: Number, default: 0, min: 0, max: 100 },
    errorRate: { type: Number, default: 0, min: 0, max: 100 },
    satisfactionScore: { type: Number, default: 0, min: 0, max: 100 },

    // Value scoring
    featureValueScore: { type: Number, default: 0, min: 0, max: 100 },
    businessImpact: { type: String, enum: ['critical', 'high', 'medium', 'low', 'unknown'], default: 'unknown' },

    // Usage patterns
    peakUsageTimes: {
      type: [
        {
          hour: { type: Number, required: true },
          dayOfWeek: { type: Number, required: true },
          usageCount: { type: Number, required: true },
        },
      ],
      default: [],
    },

    // User segments
    userSegments: {
      type: [
        {
          segment: { type: String, required: true },
          usageCount: { type: Number, required: true },
          retentionRate: { type: Number, required: true },
        },
      ],
      default: [],
    },

    // Ignored features
    ignoreRate: { type: Number, default: 0, min: 0, max: 100 },
    abandonmentRate: { type: Number, default: 0, min: 0, max: 100 },

    // Correlations
    correlatedFeatures: {
      type: [
        {
          featureName: { type: String, required: true },
          correlation: { type: Number, required: true },
        },
      ],
      default: [],
    },

    // Metadata
    firstSeen: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Query indexes
featureUsageAnalyticsSchema.index({ featureValueScore: -1 });
featureUsageAnalyticsSchema.index({ businessImpact: 1 });
featureUsageAnalyticsSchema.index({ usageFrequency: 1 });
featureUsageAnalyticsSchema.index({ ignoreRate: 1 });
featureUsageAnalyticsSchema.index({ abandonmentRate: 1 });

export const FeatureUsageAnalytics = mongoose.model<IFeatureUsageAnalytics>('FeatureUsageAnalytics', featureUsageAnalyticsSchema);
