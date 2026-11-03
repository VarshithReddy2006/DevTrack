// src/db/models/resumeVersion.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IEngineeringSignalsSnapshot {
  infraScore: number;
  systemDesignScore: number;
  dsaScore: number;
  projectQualityScore: number;
  timestamp: Date;
}

export interface IResumeVersion extends Document {
  userId: Schema.Types.ObjectId;
  resumeProfileId: Schema.Types.ObjectId;
  versionId: string;
  roleVariant: string;
  credibilitySnapshot: number;
  atsSnapshot: number;
  engineeringSignals: IEngineeringSignalsSnapshot;
  exportReferences: Schema.Types.ObjectId[];
  changeLog: string[];
  metadata: {
    generatedBy: string;
    generationReason: string;
    parentVersionId: string | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const engineeringSignalsSnapshotSchema = new Schema<IEngineeringSignalsSnapshot>(
  {
    infraScore: { type: Number, default: 0, min: 0, max: 100 },
    systemDesignScore: { type: Number, default: 0, min: 0, max: 100 },
    dsaScore: { type: Number, default: 0, min: 0, max: 100 },
    projectQualityScore: { type: Number, default: 0, min: 0, max: 100 },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const resumeVersionSchema = new Schema<IResumeVersion>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    resumeProfileId: {
      type: Schema.Types.ObjectId,
      ref: 'ResumeProfile',
      required: true,
      index: true,
    },
    versionId: {
      type: String,
      required: true,
      unique: true,
    },
    roleVariant: {
      type: String,
      required: true,
    },
    credibilitySnapshot: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    atsSnapshot: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    engineeringSignals: {
      type: engineeringSignalsSnapshotSchema,
      required: true,
    },
    exportReferences: [{
      type: Schema.Types.ObjectId,
      ref: 'ResumeExport',
    }],
    changeLog: {
      type: [String],
      default: [],
    },
    metadata: {
      generatedBy: { type: String, default: 'system' },
      generationReason: { type: String, default: 'manual' },
      parentVersionId: { type: String, default: null },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete (ret as { _id?: unknown })._id;
        delete (ret as { __v?: unknown }).__v;
        return ret;
      },
    },
  }
);

// Indexes
resumeVersionSchema.index({ userId: 1, createdAt: -1 });
resumeVersionSchema.index({ resumeProfileId: 1, createdAt: -1 });

export const ResumeVersion = model<IResumeVersion>('ResumeVersion', resumeVersionSchema);
