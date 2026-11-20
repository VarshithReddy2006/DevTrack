import { model, Schema, type Types } from 'mongoose';

/** Settings an admin can change through PATCH /ops/flags/:key. */
export const AUDITED_FLAG_FIELDS = ['name', 'description', 'enabled', 'rolloutPercent', 'allowedUserIds'] as const;
export type AuditedFlagField = (typeof AUDITED_FLAG_FIELDS)[number];

export interface FeatureFlagChange {
  field: AuditedFlagField;
  from: unknown;
  to: unknown;
}

/** One admin update of one feature flag. */
export interface IFeatureFlagAudit {
  _id: Types.ObjectId;
  flagKey: string;
  /** The flag version this update produced. */
  version: number;
  actorId: string;
  actorUsername: string;
  /** True when the update created the flag. */
  created: boolean;
  changes: FeatureFlagChange[];
  createdAt: Date;
}

const changeSchema = new Schema<FeatureFlagChange>({
  field: { type: String, required: true, enum: AUDITED_FLAG_FIELDS },
  from: { type: Schema.Types.Mixed, default: null },
  to: { type: Schema.Types.Mixed, default: null },
}, { _id: false });

const featureFlagAuditSchema = new Schema<IFeatureFlagAudit>({
  flagKey: { type: String, required: true },
  version: { type: Number, required: true },
  actorId: { type: String, required: true },
  actorUsername: { type: String, default: '' },
  created: { type: Boolean, default: false },
  changes: { type: [changeSchema], default: [] },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Newest-first reads, overall and per flag.
featureFlagAuditSchema.index({ createdAt: -1, _id: -1 });
featureFlagAuditSchema.index({ flagKey: 1, createdAt: -1, _id: -1 });

export const FeatureFlagAudit = model<IFeatureFlagAudit>('FeatureFlagAudit', featureFlagAuditSchema);
