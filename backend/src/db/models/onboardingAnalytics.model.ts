// src/db/models/onboardingAnalytics.model.ts — Onboarding Funnel and Completion Analytics
// Tracks onboarding journey, drop-offs, and completion rates

import mongoose, { Schema, type Document } from 'mongoose';

export interface IOnboardingAnalytics extends Document {
  userId: Schema.Types.ObjectId;

  // Funnel tracking
  funnelSteps: Array<{
    stepName: string;
    stepOrder: number;
    reachedAt: Date;
    completedAt?: Date;
    timeSpent: number;
    skipped: boolean;
  }>;

  // Overall metrics
  startedAt: Date;
  completedAt?: Date;
  totalDuration?: number;
  completionRate: number;
  currentStep: string;

  // Drop-off analysis
  dropOffStep?: string;
  dropOffReason?: string;
  dropOffContext?: Record<string, unknown>;

  // First session behavior
  firstSessionMetrics: {
    pageViews: number;
    timeToFirstAction: number;
    timeToFirstProblem: number;
    timeToFirstCompletion: number;
    confusionEvents: number;
    helpRequests: number;
  };

  // Setup friction
  setupFriction: {
    platformSyncIssues: number;
    authenticationIssues: number;
    configurationErrors: number;
    totalSetupTime: number;
  };

  // Early engagement
  earlyEngagement: {
    problemsAttemptedInFirstHour: number;
    problemsSolvedInFirstHour: number;
    timeToFirstStreak: number;
    returnWithin24h: boolean;
    returnWithin7d: boolean;
  };

  // Cohort information
  cohort: {
    signupDate: Date;
    acquisitionChannel?: string;
    referralSource?: string;
  };

  createdAt: Date;
  updatedAt: Date;
}

const onboardingAnalyticsSchema = new Schema<IOnboardingAnalytics>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, unique: true },

    // Funnel tracking
    funnelSteps: {
      type: [
        {
          stepName: { type: String, required: true },
          stepOrder: { type: Number, required: true },
          reachedAt: { type: Date, required: true },
          completedAt: { type: Date },
          timeSpent: { type: Number, default: 0 },
          skipped: { type: Boolean, default: false },
        },
      ],
      default: [],
    },

    // Overall metrics
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    totalDuration: { type: Number },
    completionRate: { type: Number, default: 0, min: 0, max: 100 },
    currentStep: { type: String, default: '' },

    // Drop-off analysis
    dropOffStep: { type: String },
    dropOffReason: { type: String },
    dropOffContext: { type: Object, default: {} },

    // First session behavior
    firstSessionMetrics: {
      pageViews: { type: Number, default: 0 },
      timeToFirstAction: { type: Number, default: 0 },
      timeToFirstProblem: { type: Number, default: 0 },
      timeToFirstCompletion: { type: Number, default: 0 },
      confusionEvents: { type: Number, default: 0 },
      helpRequests: { type: Number, default: 0 },
    },

    // Setup friction
    setupFriction: {
      platformSyncIssues: { type: Number, default: 0 },
      authenticationIssues: { type: Number, default: 0 },
      configurationErrors: { type: Number, default: 0 },
      totalSetupTime: { type: Number, default: 0 },
    },

    // Early engagement
    earlyEngagement: {
      problemsAttemptedInFirstHour: { type: Number, default: 0 },
      problemsSolvedInFirstHour: { type: Number, default: 0 },
      timeToFirstStreak: { type: Number },
      returnWithin24h: { type: Boolean, default: false },
      returnWithin7d: { type: Boolean, default: false },
    },

    // Cohort information
    cohort: {
      signupDate: { type: Date, required: true },
      acquisitionChannel: { type: String },
      referralSource: { type: String },
    },
  },
  { timestamps: true }
);

// Query indexes
onboardingAnalyticsSchema.index({ startedAt: -1 });
onboardingAnalyticsSchema.index({ completedAt: -1 });
onboardingAnalyticsSchema.index({ dropOffStep: 1 });
onboardingAnalyticsSchema.index({ 'cohort.signupDate': -1 });
onboardingAnalyticsSchema.index({ completionRate: -1 });

export const OnboardingAnalytics = mongoose.model<IOnboardingAnalytics>('OnboardingAnalytics', onboardingAnalyticsSchema);
