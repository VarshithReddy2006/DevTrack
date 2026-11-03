// src/db/models/betaUser.model.ts — Beta User Management
// Phase-J: Controlled Beta Infrastructure - Invite-only beta system and cohort management

import mongoose, { Schema, Document } from 'mongoose';

export interface IBetaUser extends Document {
  userId: mongoose.Types.ObjectId;
  email: string;
  inviteCode: string;
  cohortId: string;
  status: 'invited' | 'active' | 'suspended' | 'graduated';
  invitedAt: Date;
  activatedAt?: Date;
  lastActiveAt?: Date;
  featureFlags: Record<string, boolean> | Map<string, boolean>;
  betaFeatures: string[];
  feedbackCount: number;
  sessionCount: number;
  diagnosticsEnabled: boolean;
  notes?: string;
}

const BetaUserSchema = new Schema<IBetaUser>({
  userId: { type: Schema.Types.ObjectId, required: true, unique: true },
  email: { type: String, required: true },
  inviteCode: { type: String, required: true, unique: true },
  cohortId: { type: String, required: true },
  status: {
    type: String,
    enum: ['invited', 'active', 'suspended', 'graduated'],
    default: 'invited',
  },
  invitedAt: { type: Date, required: true },
  activatedAt: { type: Date },
  lastActiveAt: { type: Date },
  featureFlags: { type: Schema.Types.Mixed, default: {} },
  betaFeatures: [{ type: String }],
  feedbackCount: { type: Number, default: 0 },
  sessionCount: { type: Number, default: 0 },
  diagnosticsEnabled: { type: Boolean, default: true },
  notes: { type: String },
}, {
  timestamps: true,
});

// Indexes
BetaUserSchema.index({ email: 1 });
BetaUserSchema.index({ cohortId: 1 });
BetaUserSchema.index({ status: 1 });
BetaUserSchema.index({ invitedAt: 1 });

export const BetaUser = mongoose.model<IBetaUser>('BetaUser', BetaUserSchema);
