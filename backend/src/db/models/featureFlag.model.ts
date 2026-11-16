import { model, Schema } from 'mongoose';

export const featureFlagKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;

export interface FeatureFlagSettings {
  name: string;
  description: string;
  enabled: boolean;
  rolloutPercent: number;
  allowedUserIds: string[];
}

export interface IFeatureFlag extends FeatureFlagSettings {
  key: string;
  version: number;
  updatedAt: Date;
}

const featureFlagSchema = new Schema<IFeatureFlag>({
  key: { type: String, required: true, unique: true, immutable: true, match: featureFlagKeyPattern },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: '', maxlength: 1000 },
  enabled: { type: Boolean, default: false },
  rolloutPercent: { type: Number, default: 0, min: 0, max: 100, validate: Number.isInteger },
  allowedUserIds: [{ type: String, match: /^[0-9a-f]{24}$/ }],
  version: { type: Number, required: true, default: 0 },
}, { timestamps: { createdAt: false, updatedAt: true } });

export const FeatureFlag = model<IFeatureFlag>('FeatureFlag', featureFlagSchema);
