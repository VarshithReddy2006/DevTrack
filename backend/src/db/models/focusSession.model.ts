// ============================================================================
// focusSession.model.ts — Focus Session History
// ============================================================================
// Stores historical data for focus sessions (deep work, debugging, etc.).
// Provides quality scores and distraction metrics for the Focus Engine.
// ============================================================================

import mongoose, { Document, Schema } from 'mongoose';

export interface IFocusPause {
  startedAt: Date;
  endedAt?: Date | null;
}

export interface IFocusSession extends Document {
  userId: mongoose.Types.ObjectId;
  mode: string; // 'deep_work', 'backend', 'debug', etc.
  status: 'active' | 'running' | 'paused' | 'completed' | 'abandoned' | 'expired';
  isOpen: boolean;

  // Timing
  startedAt: Date;
  completedAt?: Date;
  plannedDurationMinutes: number;
  plannedSec: number;
  actualDurationMinutes: number;
  activeDurationMs: number;
  activeSec: number;
  pauses: IFocusPause[];
  lastResumedAt?: Date | null;
  /** Last sign of life (start, heartbeat, pause, resume). Used to reap abandoned sessions. */
  lastHeartbeatAt?: Date;

  // Quality & Consistency
  focusQualityScore: number; // 0-100
  heartbeatCount: number;
  heartbeatsCount: number;
  coveredHeartbeatIntervals?: number;
  lastCoveredHeartbeatInterval?: number;
  distractionEvents: number;

  // Work Output (linked from activity tracking during session)
  filesModified?: number;
  commitsMade?: number;
  problemsSolved?: number;
}

const FocusPauseSchema = new Schema<IFocusPause>(
  {
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
  },
  { _id: false }
);

const FocusSessionSchema = new Schema<IFocusSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mode: { type: String, required: true, default: 'deep_work' },
    status: {
      type: String,
      enum: ['active', 'running', 'paused', 'completed', 'abandoned', 'expired'],
      default: 'active',
      required: true,
    },
    isOpen: { type: Boolean, default: true, required: true },

    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date },
    plannedDurationMinutes: { type: Number, required: true, default: 25 },
    plannedSec: { type: Number, default: 1500 },
    actualDurationMinutes: { type: Number, default: 0 },
    activeDurationMs: { type: Number, default: 0, min: 0 },
    activeSec: { type: Number, default: 0, min: 0 },
    pauses: { type: [FocusPauseSchema], default: [] },
    lastResumedAt: { type: Date, default: null },
    lastHeartbeatAt: { type: Date, default: Date.now },

    focusQualityScore: { type: Number, default: 0 },
    heartbeatCount: { type: Number, default: 0 },
    heartbeatsCount: { type: Number, default: 0 },
    coveredHeartbeatIntervals: { type: Number, default: 0 },
    lastCoveredHeartbeatInterval: { type: Number, default: 0 },
    distractionEvents: { type: Number, default: 0 },

    filesModified: { type: Number, default: 0 },
    commitsMade: { type: Number, default: 0 },
    problemsSolved: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Middleware to sync isOpen, plannedSec and durations
FocusSessionSchema.pre('save', function (next) {
  if (['completed', 'abandoned', 'expired'].includes(this.status)) {
    this.isOpen = false;
  } else if (['active', 'running', 'paused'].includes(this.status)) {
    this.isOpen = true;
  }

  if (this.plannedSec && !this.plannedDurationMinutes) {
    this.plannedDurationMinutes = Math.round(this.plannedSec / 60);
  } else if (this.plannedDurationMinutes && !this.plannedSec) {
    this.plannedSec = this.plannedDurationMinutes * 60;
  }

  if (this.heartbeatCount && !this.heartbeatsCount) {
    this.heartbeatsCount = this.heartbeatCount;
  } else if (this.heartbeatsCount && !this.heartbeatCount) {
    this.heartbeatCount = this.heartbeatsCount;
  }

  next();
});

FocusSessionSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
  const update = this.getUpdate() as any;
  if (update) {
    const target = update.$set ? update.$set : update;
    if (target.status && ['completed', 'abandoned', 'expired'].includes(target.status)) {
      target.isOpen = false;
    } else if (target.status && ['active', 'running', 'paused'].includes(target.status)) {
      target.isOpen = true;
    }
  }
  next();
});


// Indexes for history queries
FocusSessionSchema.index({ userId: 1, startedAt: -1 });
FocusSessionSchema.index({ userId: 1, status: 1 });
// Partial unique index enforcing strict one-open-session constraint per user
FocusSessionSchema.index(
  { userId: 1, isOpen: 1 },
  {
    unique: true,
    name: 'uniq_open_focus_session_per_user',
    partialFilterExpression: { isOpen: true },
  }
);
// Legacy index for backward compatibility with tests expecting uniq_active_focus_session_per_user
FocusSessionSchema.index(
  { userId: 1 },
  {
    unique: true,
    name: 'uniq_active_focus_session_per_user',
    partialFilterExpression: { status: { $in: ['running', 'paused', 'active'] } },
  }
);
// Reaper scan
FocusSessionSchema.index({ status: 1, lastHeartbeatAt: 1 });

export const FocusSession = mongoose.model<IFocusSession>('FocusSession', FocusSessionSchema);
