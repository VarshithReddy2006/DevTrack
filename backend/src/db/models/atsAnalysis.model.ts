// src/db/models/atsAnalysis.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IParserWarning {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  section: string;
  suggestion: string;
}

export interface IFormattingWarning {
  type: string;
  message: string;
  location: string;
  impact: 'high' | 'medium' | 'low';
}

export interface IKeywordCoverage {
  keyword: string;
  found: boolean;
  frequency: number;
  context: string[];
}

export interface ISectionIntegrity {
  sectionName: string;
  detected: boolean;
  confidence: number;
  issues: string[];
}

export interface IATSAnalysis extends Document {
  userId: Schema.Types.ObjectId;
  resumeProfileId: Schema.Types.ObjectId;
  variantId: string | null;
  exportId: Schema.Types.ObjectId | null;
  parserWarnings: IParserWarning[];
  formattingWarnings: IFormattingWarning[];
  keywordCoverage: IKeywordCoverage[];
  sectionIntegrity: ISectionIntegrity[];
  extractionConfidence: number;
  atsScore: number;
  parsingMetadata: {
    parserVersion: string;
    analysisDate: Date;
    documentFormat: string;
    pageCount: number;
    wordCount: number;
  };
  recommendations: string[];
  createdAt: Date;
  updatedAt: Date;
}

const parserWarningSchema = new Schema<IParserWarning>(
  {
    severity: {
      type: String,
      enum: ['critical', 'warning', 'info'],
      required: true,
    },
    message: { type: String, required: true },
    section: { type: String, required: true },
    suggestion: { type: String, required: true },
  },
  { _id: false }
);

const formattingWarningSchema = new Schema<IFormattingWarning>(
  {
    type: { type: String, required: true },
    message: { type: String, required: true },
    location: { type: String, required: true },
    impact: {
      type: String,
      enum: ['high', 'medium', 'low'],
      required: true,
    },
  },
  { _id: false }
);

const keywordCoverageSchema = new Schema<IKeywordCoverage>(
  {
    keyword: { type: String, required: true },
    found: { type: Boolean, required: true },
    frequency: { type: Number, default: 0 },
    context: { type: [String], default: [] },
  },
  { _id: false }
);

const sectionIntegritySchema = new Schema<ISectionIntegrity>(
  {
    sectionName: { type: String, required: true },
    detected: { type: Boolean, required: true },
    confidence: { type: Number, default: 0, min: 0, max: 100 },
    issues: { type: [String], default: [] },
  },
  { _id: false }
);

const atsAnalysisSchema = new Schema<IATSAnalysis>(
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
    exportId: {
      type: Schema.Types.ObjectId,
      ref: 'ResumeExport',
      default: null,
      index: true,
    },
    parserWarnings: {
      type: [parserWarningSchema],
      default: [],
    },
    formattingWarnings: {
      type: [formattingWarningSchema],
      default: [],
    },
    keywordCoverage: {
      type: [keywordCoverageSchema],
      default: [],
    },
    sectionIntegrity: {
      type: [sectionIntegritySchema],
      default: [],
    },
    extractionConfidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    atsScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      index: true,
    },
    parsingMetadata: {
      parserVersion: { type: String, default: '1.0.0' },
      analysisDate: { type: Date, default: Date.now },
      documentFormat: { type: String, default: 'pdf' },
      pageCount: { type: Number, default: 1 },
      wordCount: { type: Number, default: 0 },
    },
    recommendations: {
      type: [String],
      default: [],
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
atsAnalysisSchema.index({ userId: 1, atsScore: -1 });
atsAnalysisSchema.index({ resumeProfileId: 1, createdAt: -1 });
atsAnalysisSchema.index({ variantId: 1 });

export const ATSAnalysis = model<IATSAnalysis>('ATSAnalysis', atsAnalysisSchema);
