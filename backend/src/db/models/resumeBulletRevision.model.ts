import { Schema, model, type Types } from 'mongoose';
import type { Operation } from 'fast-json-patch';
import type { IBulletEdit } from './resumeVariant.model.js';

export interface IResumeBulletRevision {
  userId: Types.ObjectId;
  resumeId: Types.ObjectId;
  sectionId: string;
  versionNumber: number;
  patch: Operation[];
  inversePatch: Operation[];
  // State immediately BEFORE the oldest retained revision; rebased on pruning.
  baseSnapshot?: IBulletEdit[];
  atsScore: number;
  restoredFrom?: number;
  createdAt: Date;
}

const schema = new Schema<IResumeBulletRevision>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  resumeId: { type: Schema.Types.ObjectId, ref: 'ResumeVariant', required: true },
  sectionId: { type: String, required: true, maxlength: 50 },
  versionNumber: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  patch: { type: Schema.Types.Mixed, required: true, validate: Array.isArray },
  inversePatch: { type: Schema.Types.Mixed, required: true, validate: Array.isArray },
  baseSnapshot: { type: [Schema.Types.Mixed], default: undefined },
  atsScore: { type: Number, required: true, min: 0, max: 100 },
  restoredFrom: { type: Number, min: 0 },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ resumeId: 1, versionNumber: -1 }, { unique: true });
schema.index({ userId: 1, resumeId: 1, versionNumber: 1 });

export const ResumeBulletRevision = model<IResumeBulletRevision>('ResumeBulletRevision', schema);
