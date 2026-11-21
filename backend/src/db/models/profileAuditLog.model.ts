import mongoose, { Document, Schema, Types } from 'mongoose';
import type { EncryptedAuditPayload } from '../../modules/audit/auditChain.service.js';

export type ProfileAuditEventType =
  | 'profile_computed'
  | 'anti_gaming_check'
  | 'flag_raised'
  | 'flag_cleared'
  | 'project_verified'
  | 'project_rejected'
  | 'visibility_changed'
  | 'dossier_downloaded'
  | 'anti_gaming_pardoned'
  | 'anti_gaming_penalized'
  | 'ACCOUNT_ERASURE_TOMBSTONE';

export interface IProfileAuditLog extends Document {
  userId?: Types.ObjectId | null;
  subjectHash?: string | null;
  eventType: ProfileAuditEventType;
  triggeredBy: 'system' | 'admin' | 'user';
  details: Record<string, unknown>;
  encryptedDetails?: EncryptedAuditPayload | null;
  sequenceNumber?: number | null;
  previousHash?: string | null;
  chainTimestamp?: string | null;
  payloadHash?: string | null;
  recordHash?: string | null;
  suspicionScoreBefore: number | null;
  suspicionScoreAfter: number | null;
  createdAt: Date;
}

const EncryptedDetailsSchema = new Schema<EncryptedAuditPayload>(
  {
    algorithm: { type: String, enum: ['aes-256-gcm'], required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    ciphertext: { type: String, required: true },
  },
  { _id: false }
);

const ProfileAuditLogSchema = new Schema<IProfileAuditLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: false, default: null },
    subjectHash: { type: String, required: false, default: null },
    eventType: {
      type: String,
      enum: [
        'profile_computed',
        'anti_gaming_check',
        'flag_raised',
        'flag_cleared',
        'project_verified',
        'project_rejected',
        'visibility_changed',
        'dossier_downloaded',
        'ACCOUNT_ERASURE_TOMBSTONE',
        'anti_gaming_pardoned',
        'anti_gaming_penalized',
      ],
      required: true,
    },
    triggeredBy: { type: String, enum: ['system', 'admin', 'user'], required: true },
    details: { type: Schema.Types.Mixed, default: {} },
    encryptedDetails: { type: EncryptedDetailsSchema, required: false, default: null },
    sequenceNumber: { type: Number, required: false, default: null },
    previousHash: { type: String, required: false, default: null },
    chainTimestamp: { type: String, required: false, default: null },
    payloadHash: { type: String, required: false, default: null },
    recordHash: { type: String, required: false, default: null },
    suspicionScoreBefore: { type: Number, default: null },
    suspicionScoreAfter: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ProfileAuditLogSchema.index({ userId: 1, createdAt: -1 });
ProfileAuditLogSchema.index({ subjectHash: 1, createdAt: -1 });
ProfileAuditLogSchema.index({ eventType: 1, createdAt: -1 });
ProfileAuditLogSchema.index(
  { sequenceNumber: 1 },
  { unique: true, partialFilterExpression: { sequenceNumber: { $type: 'number' } } }
);
// TTL: 90 days (auto-expire old audit logs). Maintainer anti-gaming decisions are also written to
// AntiGamingDecision, which has no TTL, so the permanent record does not depend on this collection.
ProfileAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const ProfileAuditLog = mongoose.model<IProfileAuditLog>('ProfileAuditLog', ProfileAuditLogSchema);

/**
 * Per-user cryptographic key store for GDPR crypto-shredding of audit PII.
 * Deleting this document during account erasure permanently renders all
 * `encryptedDetails` and `subjectHash` fields in immutable ProfileAuditLog
 * entries unreadable without mutating the audit hash chain.
 */
export interface IAuditEncryptionKey extends Document {
  userId: Types.ObjectId;
  keyHex: string;
  saltHex: string;
  createdAt: Date;
  updatedAt: Date;
}

const AuditEncryptionKeySchema = new Schema<IAuditEncryptionKey>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    keyHex: { type: String, required: true },
    saltHex: { type: String, required: true },
  },
  { timestamps: true }
);

AuditEncryptionKeySchema.index({ userId: 1 }, { unique: true });

export const AuditEncryptionKey = mongoose.model<IAuditEncryptionKey>(
  'AuditEncryptionKey',
  AuditEncryptionKeySchema
);
