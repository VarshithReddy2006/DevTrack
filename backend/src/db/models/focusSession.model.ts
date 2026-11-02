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
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    mode: { type: String, required: true },
    status: { type: String, enum: ['completed', 'abandoned', 'paused', 'running'], required: true },
    
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    plannedDurationMinutes: { type: Number, required: true },
    actualDurationMinutes: { type: Number, default: 0 },
    activeDurationMs: { type: Number, default: 0, min: 0 },
    lastResumedAt: { type: Date, default: null },
    
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

export const FocusSession = mongoose.model<IFocusSession>('FocusSession', FocusSessionSchema);
