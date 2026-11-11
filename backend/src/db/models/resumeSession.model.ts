// src/db/models/resumeSession.model.ts
import { Schema, model, type Document } from 'mongoose';

export type ProcessingStage = 
  | 'UPLOADED'
  | 'VALIDATING'
  | 'PARSING'
  | 'EXTRACTING'
  | 'ATS_ANALYZING'
  | 'EMBEDDING'
  | 'SEMANTIC_ANALYZING'
  | 'RECOMMENDING'
  | 'REPLAY_GENERATING'
  | 'REPORT_GENERATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'DEGRADED';


export interface IResumeSession extends Document {
  sessionId: string;
  userId?: Schema.Types.ObjectId;
  
  // Upload metadata
  uploadMetadata: {
    originalFilename: string;
    fileType: 'pdf' | 'docx' | 'txt' | 'md';
    fileSize: number;
    mimeType: string;
    uploadPath: string;
    uploadedAt: Date;
  };
  
  // Parsed content
  parsedContent: {
    text: string;
    sections: { [key: string]: string };
    headings: string[];
    bullets: { level: number; text: string }[];
    links: string[];
    metadata: {
      pages?: number;
      isMarkdown?: boolean;
      [key: string]: any;
    };
    parsingDiagnostics: {
      confidence: number;
      warnings: string[];
      errors: string[];
    };
    extractedAt?: Date;
  };
  
  // Processing state
  currentStage: ProcessingStage;
  processingHistory: {
    stage: ProcessingStage;
    startedAt: Date;
    completedAt?: Date;
    duration?: number;
    status: 'success' | 'failed' | 'degraded';
    error?: string;
  }[];

  checkpointState: {
    stage: ProcessingStage;
    savedAt: Date;
    snapshot: Record<string, unknown>;
  };
  
  // ATS state
  atsState: {
    analyzed: boolean;
    atsScore?: number;
    parserWarnings?: any[];
    formattingWarnings?: any[];
    keywordCoverage?: any[];
    sectionIntegrity?: any[];
    extractionConfidence?: number;
    recommendations?: string[];
    analyzedAt?: Date;
  };
  
  // Embedding state
  embeddingState: {
    generated: boolean;
    vector?: number[];
    provider?: 'openai' | 'gemini';
    dimensions?: number;
    embeddingVersion?: string;
    semanticHash?: string;
    generatedAt?: Date;
    error?: string;
  };
  
  // Semantic state
  semanticState: {
    analyzed: boolean;
    retrievalResults?: { id: string; score: number }[];
    semanticSimilarity?: number;
    analyzedAt?: Date;
    error?: string;
  };
  
  // Recommendation state
  recommendationState: {
    generated: boolean;
    recommendations?: string[];
    credibilityScore?: number;
    warnings?: string[];
    generatedAt?: Date;
    error?: string;
  };
  
  // Replay state
  replayState: {
    generated: boolean;
    snapshots?: any[];
    replayHistory?: any[];
    timeline?: any[];
    generatedAt?: Date;
    error?: string;
  };

  runtimeEvents: {
    stage: string;
    emittedStage?: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'degraded';
    timestamp: Date;
    progress: number;
    confidence?: number;
    latencyMs?: number;
    warnings?: string[];
    errors?: string[];
    metadata?: any;
  }[];

  evolutionSnapshots: {
    timestamp: Date;
    previousSessionId?: string;
    deltas: {
      atsScore?: number;
      semanticSimilarity?: number;
      credibilityScore?: number;
      recommendationCount?: number;
      parserConfidence?: number;
    };
    improved: string[];
    regressed: string[];
    unchangedWeakSignals: string[];
  }[];

  // Report state
  reportState: {
    generated: boolean;
    reportData?: any;
    generatedAt?: Date;
    error?: string;
  };

  
  // Failure states
  failureState: {
    failed: boolean;
    failureStage?: ProcessingStage;
    failureReason?: string;
    failureDetails?: any;
    failedAt?: Date;
    retryCount?: number;
  };
  
  // Degraded state
  degradedState: {
    degraded: boolean;
    degradedComponents?: string[];
    degradedReason?: string;
    degradedAt?: Date;
  };
  
  // Runtime timestamps
  timestamps: {
    uploadedAt: Date;
    startedProcessingAt?: Date;
    completedAt?: Date;
    lastUpdated: Date;
  };
  
  createdAt: Date;
  updatedAt: Date;
}

const resumeSessionSchema = new Schema<IResumeSession>(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    
    uploadMetadata: {
      originalFilename: { type: String, required: true },
      fileType: { type: String, required: true, enum: ['pdf', 'docx', 'txt', 'md'] },
      fileSize: { type: Number, required: true },
      mimeType: { type: String, required: true },
      uploadPath: { type: String, required: true },
      uploadedAt: { type: Date, required: true },
    },
    
    parsedContent: {
      text: { type: String },
      sections: { type: Schema.Types.Mixed, default: {} },
      headings: { type: [String], default: [] },
      bullets: { type: Schema.Types.Mixed, default: [] },
      links: { type: [String], default: [] },
      metadata: { type: Schema.Types.Mixed, default: {} },
      parsingDiagnostics: {
        confidence: { type: Number, default: 0 },
        warnings: { type: [String], default: [] },
        errors: { type: [String], default: [] },
      },
      extractedAt: { type: Date },
    },
    
    currentStage: {
      type: String,
      required: true,
      enum: ['UPLOADED', 'VALIDATING', 'PARSING', 'EXTRACTING', 'ATS_ANALYZING', 'EMBEDDING', 'SEMANTIC_ANALYZING', 'RECOMMENDING', 'REPLAY_GENERATING', 'REPORT_GENERATING', 'COMPLETED', 'FAILED', 'DEGRADED'],
      default: 'UPLOADED',
    },

    
    processingHistory: [{
      stage: {
        type: String,
        required: true,
        enum: ['UPLOADED', 'VALIDATING', 'PARSING', 'EXTRACTING', 'ATS_ANALYZING', 'EMBEDDING', 'SEMANTIC_ANALYZING', 'RECOMMENDING', 'REPLAY_GENERATING', 'REPORT_GENERATING', 'COMPLETED', 'FAILED', 'DEGRADED'],
      },

      startedAt: { type: Date, required: true },
      completedAt: { type: Date },
      duration: { type: Number },
      status: { type: String, required: true, enum: ['success', 'failed', 'degraded'] },
      error: { type: String },
    }],

    checkpointState: {
      stage: { type: String, enum: ['UPLOADED', 'VALIDATING', 'PARSING', 'EXTRACTING', 'ATS_ANALYZING', 'EMBEDDING', 'SEMANTIC_ANALYZING', 'RECOMMENDING', 'REPLAY_GENERATING', 'REPORT_GENERATING', 'COMPLETED', 'FAILED', 'DEGRADED'] },
      savedAt: { type: Date },
      snapshot: { type: Schema.Types.Mixed, default: {} },
    },
    
    atsState: {
      analyzed: { type: Boolean, default: false },
      atsScore: { type: Number },
      parserWarnings: { type: Schema.Types.Mixed },
      formattingWarnings: { type: Schema.Types.Mixed },
      keywordCoverage: { type: Schema.Types.Mixed },
      sectionIntegrity: { type: Schema.Types.Mixed },
      extractionConfidence: { type: Number },
      recommendations: { type: [String] },
      analyzedAt: { type: Date },
    },
    
    embeddingState: {
      generated: { type: Boolean, default: false },
      vector: { type: [Number] },
      provider: { type: String, enum: ['openai', 'gemini'] },
      dimensions: { type: Number },
      embeddingVersion: { type: String },
      semanticHash: { type: String },
      generatedAt: { type: Date },
      error: { type: String },
    },
    
    semanticState: {
      analyzed: { type: Boolean, default: false },
      retrievalResults: { type: Schema.Types.Mixed },
      semanticSimilarity: { type: Number },
      analyzedAt: { type: Date },
      error: { type: String },
    },
    
    recommendationState: {
      generated: { type: Boolean, default: false },
      recommendations: { type: [String] },
      credibilityScore: { type: Number },
      warnings: { type: [String] },
      generatedAt: { type: Date },
      error: { type: String },
    },
    
    replayState: {
      generated: { type: Boolean, default: false },
      snapshots: { type: Schema.Types.Mixed },
      replayHistory: { type: Schema.Types.Mixed },
      timeline: { type: Schema.Types.Mixed },
      generatedAt: { type: Date },
      error: { type: String },
    },

    runtimeEvents: [{
      stage: { type: String, required: true },
      emittedStage: { type: String },
      status: { type: String, required: true, enum: ['pending', 'running', 'completed', 'failed', 'degraded'] },
      timestamp: { type: Date, required: true },
      progress: { type: Number, required: true },
      confidence: { type: Number },
      latencyMs: { type: Number },
      warnings: { type: [String], default: [] },
      errors: { type: [String], default: [] },
      metadata: { type: Schema.Types.Mixed },
    }],

    evolutionSnapshots: [{
      timestamp: { type: Date, required: true },
      previousSessionId: { type: String },
      deltas: { type: Schema.Types.Mixed, default: {} },
      improved: { type: [String], default: [] },
      regressed: { type: [String], default: [] },
      unchangedWeakSignals: { type: [String], default: [] },
    }],
    
    reportState: {
      generated: { type: Boolean, default: false },
      reportData: { type: Schema.Types.Mixed },
      generatedAt: { type: Date },
      error: { type: String },
    },

    
    failureState: {
      failed: { type: Boolean, default: false },
      failureStage: { type: String, enum: ['UPLOADED', 'VALIDATING', 'PARSING', 'EXTRACTING', 'ATS_ANALYZING', 'EMBEDDING', 'SEMANTIC_ANALYZING', 'RECOMMENDING', 'REPLAY_GENERATING', 'REPORT_GENERATING', 'COMPLETED', 'FAILED', 'DEGRADED'] },

      failureReason: { type: String },
      failureDetails: { type: Schema.Types.Mixed },
      failedAt: { type: Date },
      retryCount: { type: Number, default: 0 },
    },
    
    degradedState: {
      degraded: { type: Boolean, default: false },
      degradedComponents: { type: [String] },
      degradedReason: { type: String },
      degradedAt: { type: Date },
    },
    
    timestamps: {
      uploadedAt: { type: Date, required: true },
      startedProcessingAt: { type: Date },
      completedAt: { type: Date },
      lastUpdated: { type: Date, required: true },
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
resumeSessionSchema.index({ userId: 1 });
resumeSessionSchema.index({ currentStage: 1 });
resumeSessionSchema.index({ 'timestamps.uploadedAt': -1 });
resumeSessionSchema.index({ 'timestamps.completedAt': -1 });
resumeSessionSchema.index({ userId: 1, 'timestamps.completedAt': -1 });

export const ResumeSession = model<IResumeSession>('ResumeSession', resumeSessionSchema);
