// ============================================================================
// focusSession.model.ts — Focus Session History
// ============================================================================
// Stores historical data for focus sessions (deep work, debugging, etc.).
// Provides quality scores and distraction metrics for the Focus Engine.
// ============================================================================

import mongoose, { Document, Schema } from 'mongoose';

export interface IFocusSession extends Document {
  userId: mongoose.Types.ObjectId;
  mode: string; // 'deep_work', 'backend', 'debug', etc.
  status: 'completed' | 'abandoned' | 'paused' | 'running';
  
  // Timing
  startedAt: Date;
  completedAt?: Date;
  plannedDurationMinutes: number;
  actualDurationMinutes: number;
  activeDurationMs: number;
  lastResumedAt?: Date | null;
  /** Last sign of life (start, heartbeat, pause, resume). Used to reap abandoned sessions. */
  lastHeartbeatAt?: Date;

  // Quality & Consistency
  focusQualityScore: number; // 0-100
  heartbeatCount: number;
  distractionEvents: number;
  
  // Work Output (linked from activity tracking during session)
  filesModified?: number;
  commitsMade?: number;
  problemsSolved?: number;
}

const FocusSessionSchema = new Schema<IFocusSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mode: { type: String, required: true },
    status: { type: String, enum: ['completed', 'abandoned', 'paused', 'running'], required: true },
    
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    plannedDurationMinutes: { type: Number, required: true },
    actualDurationMinutes: { type: Number, default: 0 },
    activeDurationMs: { type: Number, default: 0, min: 0 },
    lastResumedAt: { type: Date, default: null },
    lastHeartbeatAt: { type: Date },
    
    focusQualityScore: { type: Number, default: 0 },
    heartbeatCount: { type: Number, default: 0 },
    distractionEvents: { type: Number, default: 0 },
    
    filesModified: { type: Number, default: 0 },
    commitsMade: { type: Number, default: 0 },
    problemsSolved: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Indexes for history queries
FocusSessionSchema.index({ userId: 1, startedAt: -1 });
FocusSessionSchema.index({ userId: 1, status: 1 });
// At most one live (running or paused) session per user. This is the lock that
// makes concurrent starts safe: the second insert fails with E11000.
FocusSessionSchema.index(
  { userId: 1 },
  { unique: true, name: 'uniq_active_focus_session_per_user', partialFilterExpression: { status: { $in: ['running', 'paused'] } } }
);
// Reaper scan
FocusSessionSchema.index({ status: 1, lastHeartbeatAt: 1 });

export const FocusSession = mongoose.model<IFocusSession>('FocusSession', FocusSessionSchema);
