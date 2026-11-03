// src/db/models/sessionReplay.model.ts — Session Replay Metadata
// Phase-J: Real User Observation System - Session replay metadata and UX friction tracking

import mongoose, { Schema, Document } from 'mongoose';

export interface ISessionReplay extends Document {
  sessionId: string;
  userId: mongoose.Types.ObjectId;
  betaUserId?: mongoose.Types.ObjectId;
  cohortId?: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  pages: Array<{
    path: string;
    enteredAt: Date;
    exitedAt?: Date;
    duration?: number;
  }>;
  interactions: Array<{
    element: string;
    action: string;
    timestamp: Date;
    context?: Record<string, unknown>;
  }>;
  frictionEvents: Array<{
    element: string;
    type: 'hesitation' | 'confusion' | 'error' | 'abandonment';
    severity: 'low' | 'medium' | 'high';
    timestamp: Date;
    context?: Record<string, unknown>;
  }>;
  networkRequests: Array<{
    url: string;
    method: string;
    status: number;
    duration: number;
    timestamp: Date;
  }>;
  performanceMetrics: {
    loadTime?: number;
    firstContentfulPaint?: number;
    timeToInteractive?: number;
    cumulativeLayoutShift?: number;
  };
  deviceInfo: {
    userAgent: string;
    viewport: { width: number; height: number };
    deviceType?: 'desktop' | 'tablet' | 'mobile';
  };
  diagnosticsEnabled: boolean;
  notes?: string;
}

const SessionReplaySchema = new Schema<ISessionReplay>({
  sessionId: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  betaUserId: { type: Schema.Types.ObjectId },
  cohortId: { type: String },
  startTime: { type: Date, required: true },
  endTime: { type: Date },
  duration: { type: Number },
  pages: [{
    path: { type: String, required: true },
    enteredAt: { type: Date, required: true },
    exitedAt: { type: Date },
    duration: { type: Number },
  }],
  interactions: [{
    element: { type: String, required: true },
    action: { type: String, required: true },
    timestamp: { type: Date, required: true },
    context: { type: Map, of: Schema.Types.Mixed },
  }],
  frictionEvents: [{
    element: { type: String, required: true },
    type: {
      type: String,
      enum: ['hesitation', 'confusion', 'error', 'abandonment'],
      required: true,
    },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high'],
      required: true,
    },
    timestamp: { type: Date, required: true },
    context: { type: Map, of: Schema.Types.Mixed },
  }],
  networkRequests: [{
    url: { type: String, required: true },
    method: { type: String, required: true },
    status: { type: Number, required: true },
    duration: { type: Number, required: true },
    timestamp: { type: Date, required: true },
  }],
  performanceMetrics: {
    loadTime: { type: Number },
    firstContentfulPaint: { type: Number },
    timeToInteractive: { type: Number },
    cumulativeLayoutShift: { type: Number },
  },
  deviceInfo: {
    userAgent: { type: String, required: true },
    viewport: {
      width: { type: Number, required: true },
      height: { type: Number, required: true },
    },
    deviceType: { type: String, enum: ['desktop', 'tablet', 'mobile'] },
  },
  diagnosticsEnabled: { type: Boolean, default: true },
  notes: { type: String },
}, {
  timestamps: true,
});

// Indexes
SessionReplaySchema.index({ userId: 1 });
SessionReplaySchema.index({ betaUserId: 1 });
SessionReplaySchema.index({ cohortId: 1 });
SessionReplaySchema.index({ startTime: -1 });
SessionReplaySchema.index({ 'frictionEvents.timestamp': -1 });
// TTL: auto-delete session replays after 30 days to prevent storage explosion
SessionReplaySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const SessionReplay = mongoose.model<ISessionReplay>('SessionReplay', SessionReplaySchema);
