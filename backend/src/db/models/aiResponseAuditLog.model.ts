import mongoose, { Schema } from 'mongoose';

export const AI_AUDIT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const AI_AUDIT_ERROR_CODES = [
  'provider_error',
  'provider_not_configured',
  'provider_timeout',
  'provider_rate_limited',
  'provider_circuit_open',
] as const;

export type AIAuditErrorCode = typeof AI_AUDIT_ERROR_CODES[number];

export interface IAIResponseAuditLog {
  userId: string;
  requestType?: string;
  prompt?: string;
  response?: string;
  model?: string;
  provider: string;
  latencyMs: number;
  tokensUsed: number;
  cached?: boolean;
  contextVersion?: string;
  responseConfidence?: number;
  moderationFlags: string[];
  hallucinationFlags: string[];
  safetyViolations?: string[];
  success?: boolean;
  errorCode?: AIAuditErrorCode;
  createdAt: Date;
}

const AIResponseAuditLogSchema = new Schema<IAIResponseAuditLog>(
  {
    userId: { type: String, required: true, index: true },
    requestType: String,
    // Optional fields retained for reading records written by older deployments.
    prompt: String,
    response: String,
    model: String,
    provider: { type: String, required: true },
    latencyMs: { type: Number, required: true },
    tokensUsed: { type: Number, default: 0 },
    cached: { type: Boolean, default: false },
    contextVersion: String,
    responseConfidence: Number,
    moderationFlags: [{ type: String }],
    hallucinationFlags: [{ type: String }],
    safetyViolations: [{ type: String }],
    success: { type: Boolean, default: true },
    errorCode: { type: String, enum: AI_AUDIT_ERROR_CODES },
  },
  { timestamps: { createdAt: true, updatedAt: false }, bufferCommands: false }
);

AIResponseAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: AI_AUDIT_RETENTION_SECONDS });
AIResponseAuditLogSchema.index({ userId: 1, createdAt: -1, _id: -1 });

export const AIResponseAuditLog = mongoose.model<IAIResponseAuditLog>('AIResponseAuditLog', AIResponseAuditLogSchema);
