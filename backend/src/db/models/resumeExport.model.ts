// src/db/models/resumeExport.model.ts
import { Schema, model, type Document } from 'mongoose';

export type ExportType = 'pdf' | 'docx' | 'html' | 'json' | 'txt' | 'md';
export type ATSValidationState = 'pending' | 'passed' | 'failed' | 'warning';

export interface IResumeExport extends Document {
  userId: Schema.Types.ObjectId;
  resumeProfileId: Schema.Types.ObjectId;
  variantId: string | null;
  exportType: ExportType;
  exportPath: string;
  checksum: string;
  atsValidationState: ATSValidationState;
  exportVersion: string;
  templateVersion: string;
  metadata: {
    fileSize: number;
    pageCount: number;
    generationDurationMs: number;
    atsAnalysisId: Schema.Types.ObjectId | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const resumeExportSchema = new Schema<IResumeExport>(
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
    variantId: {
      type: String,
      default: null,
    },
    exportType: {
      type: String,
      enum: ['pdf', 'docx', 'html', 'json', 'txt', 'md'],
      required: true,
      default: 'pdf',
    },
    exportPath: {
      type: String,
      required: true,
    },
    checksum: {
      type: String,
      required: true,
    },
    atsValidationState: {
      type: String,
      enum: ['pending', 'passed', 'failed', 'warning'],
      default: 'pending',
    },
    exportVersion: {
      type: String,
      required: true,
      default: '1.0.0',
    },
    templateVersion: {
      type: String,
      required: true,
      default: '1.0.0',
    },
    metadata: {
      fileSize: { type: Number, default: 0 },
      pageCount: { type: Number, default: 1 },
      generationDurationMs: { type: Number, default: 0 },
      atsAnalysisId: {
        type: Schema.Types.ObjectId,
        ref: 'ATSAnalysis',
        default: null,
      },
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
resumeExportSchema.index({ userId: 1, createdAt: -1 });
resumeExportSchema.index({ resumeProfileId: 1, createdAt: -1 });
resumeExportSchema.index({ variantId: 1 });
resumeExportSchema.index({ atsValidationState: 1 });

export const ResumeExport = model<IResumeExport>('ResumeExport', resumeExportSchema);
