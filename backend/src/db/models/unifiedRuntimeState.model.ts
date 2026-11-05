// src/db/models/unifiedRuntimeState.model.ts — Unified Runtime State
// Single source of truth for all progression systems.
// Event-driven, replay-safe, SSE-synchronized runtime state.

import mongoose, { Schema, type Document } from 'mongoose';

// Momentum states
export type MomentumState = 'building' | 'stable' | 'declining' | 'recovering' | 'dormant';

// Fatigue states
export type FatigueState = 'none' | 'low' | 'moderate' | 'high' | 'burnout';

// Emotional states
export type EmotionalState = 'motivated' | 'focused' | 'calm' | 'neutral' | 'discouraged' | 'overwhelmed';

// Recovery states
export type RecoveryState = 'none' | 'active' | 'paused' | 'complete';

// Onboarding stages
export type OnboardingStage = 'new' | 'first_problem' | 'first_streak' | 'first_challenge' | 'active';

// Engagement pressure levels
export type EngagementPressure = 'none' | 'gentle' | 'normal' | 'intense';

// Active goal reference
export interface ActiveGoalRef {
  goalId: string;
  progress: number;
  target: number;
  deadline?: Date;
}

// Active challenge reference
export interface ActiveChallengeRef {
  challengeId: string;
  progress: number;
  target: number;
  startedAt: Date;
  expiresAt?: Date;
}

// Active achievement reference
export interface ActiveAchievementRef {
  achievementId: string;
  unlockedAt: Date;
  milestone?: number;
}

// Near milestone reference
export interface NearMilestoneRef {
  type: 'level' | 'streak' | 'problems' | 'xp';
  current: number;
  target: number;
  progressPercent: number;
  estimatedCompletion?: Date;
}

// Session context
export interface SessionContext {
  isActive: boolean;
  sessionId?: string;
  mode?: string;
  duration?: number;
  startedAt?: Date;
  lastHeartbeat?: Date;
  status?: 'running' | 'paused' | 'completed' | 'abandoned';
  activeDurationMs?: number;
  lastResumedAt?: Date | null;
  problemsThisSession: number;
  xpThisSession: number;
}

// Current behavioral message
export interface CurrentMessage {
  messageId: string;
  tone: 'encouraging' | 'calm' | 'celebratory' | 'gentle-nudge' | 'supportive' | 'silent';
  text: string;
  action?: { label: string; route: string };
  expiresAt: Date;
  dismissedAt?: Date;
}

// Recent milestone
export interface RecentMilestoneRef {
  type: 'level_up' | 'streak_milestone' | 'achievement_unlocked' | 'goal_completed' | 'challenge_completed';
  label: string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

// Progression pacing
export interface ProgressionPacing {
  dailyXpRate: number;
  weeklyXpRate: number;
  streakGrowthRate: number;
  optimalSessionLength: number; // in minutes
  recommendedBreakInterval: number; // in minutes
}

export interface IUnifiedRuntimeState extends Document {
  userId: Schema.Types.ObjectId;
  
  // Core progression
  xp: number;
  level: number;
  xpToNextLevel: number;
  streak: number;
  streakRisk: number; // 0-1, probability of losing streak
  
  // Behavioral state
  momentumState: MomentumState;
  fatigueState: FatigueState;
  trustScore: number; // 0-1, user trust in system
  emotionalState: EmotionalState;
  recoveryState: RecoveryState;
  
  // Active systems
  activeGoals: ActiveGoalRef[];
  activeChallenges: ActiveChallengeRef[];
  activeAchievements: ActiveAchievementRef[];
  
  // Progression intelligence
  progressionPacing: ProgressionPacing;
  nearMilestones: NearMilestoneRef[];
  
  // Denormalized stats (reduces query scatter)
  longestStreak: number;
  daysActive: number;
  totalProblemsSolved: number;
  
  // Session & messaging
  sessionContext: SessionContext;
  currentMessage?: CurrentMessage;
  recentMilestones: RecentMilestoneRef[];
  
  // User journey
  onboardingStage: OnboardingStage;
  engagementPressure: EngagementPressure;
  
  // Metadata
  lastEventId: string; // For replay-safe rebuilding
  lastCalculatedAt: Date;
  version: number; // For schema migrations
  updatedAt: Date;
}

const unifiedRuntimeStateSchema = new Schema<IUnifiedRuntimeState>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, unique: true },
    
    // Core progression
    xp: { type: Number, default: 0, min: 0 },
    level: { type: Number, default: 1, min: 1 },
    xpToNextLevel: { type: Number, default: 100, min: 0 },
    streak: { type: Number, default: 0, min: 0 },
    streakRisk: { type: Number, default: 0, min: 0, max: 1 },
    
    // Behavioral state
    momentumState: {
      type: String,
      enum: ['building', 'stable', 'declining', 'recovering', 'dormant'],
      default: 'building',
    },
    fatigueState: {
      type: String,
      enum: ['none', 'low', 'moderate', 'high', 'burnout'],
      default: 'none',
    },
    trustScore: { type: Number, default: 0.5, min: 0, max: 1 },
    emotionalState: {
      type: String,
      enum: ['motivated', 'focused', 'calm', 'neutral', 'discouraged', 'overwhelmed'],
      default: 'neutral',
    },
    recoveryState: {
      type: String,
      enum: ['none', 'active', 'paused', 'complete'],
      default: 'none',
    },
    
    // Active systems
    activeGoals: [{ type: Schema.Types.Mixed }],
    activeChallenges: [{ type: Schema.Types.Mixed }],
    activeAchievements: [{ type: Schema.Types.Mixed }],
    
    // Progression intelligence
    progressionPacing: {
      dailyXpRate: { type: Number, default: 0 },
      weeklyXpRate: { type: Number, default: 0 },
      streakGrowthRate: { type: Number, default: 0 },
      optimalSessionLength: { type: Number, default: 30 },
      recommendedBreakInterval: { type: Number, default: 60 },
    },
    nearMilestones: [{ type: Schema.Types.Mixed }],
    
    // Denormalized stats
    longestStreak: { type: Number, default: 0, min: 0 },
    daysActive: { type: Number, default: 0, min: 0 },
    totalProblemsSolved: { type: Number, default: 0, min: 0 },
    
    // Session & messaging
    sessionContext: {
      isActive: { type: Boolean, default: false },
      sessionId: { type: String },
      mode: { type: String },
      duration: { type: Number },
      startedAt: { type: Date },
      lastHeartbeat: { type: Date },
      status: { type: String, enum: ['running', 'paused', 'completed', 'abandoned'] },
      activeDurationMs: { type: Number, default: 0, min: 0 },
      lastResumedAt: { type: Date, default: null },
      problemsThisSession: { type: Number, default: 0 },
      xpThisSession: { type: Number, default: 0 },
    },
    currentMessage: { type: Schema.Types.Mixed },
    recentMilestones: [{ type: Schema.Types.Mixed }],
    
    // User journey
    onboardingStage: {
      type: String,
      enum: ['new', 'first_problem', 'first_streak', 'first_challenge', 'active'],
      default: 'new',
    },
    engagementPressure: {
      type: String,
      enum: ['none', 'gentle', 'normal', 'intense'],
      default: 'normal',
    },
    
    // Metadata
    lastEventId: { type: String, default: '' },
    lastCalculatedAt: { type: Date, default: Date.now },
    version: { type: Number, default: 1 },
  },
  { timestamps: { updatedAt: true } }
);

// Indexes for efficient queries
unifiedRuntimeStateSchema.index({ userId: 1, updatedAt: -1 });
unifiedRuntimeStateSchema.index({ streak: -1 });
unifiedRuntimeStateSchema.index({ momentumState: 1 });
unifiedRuntimeStateSchema.index({ fatigueState: 1 });

export const UnifiedRuntimeState = mongoose.model<IUnifiedRuntimeState>('UnifiedRuntimeState', unifiedRuntimeStateSchema);
