import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IProfileAuditLog extends Document {
  userId: Types.ObjectId;
  eventType:
    | 'profile_computed'
    | 'anti_gaming_check'
    | 'flag_raised'
    | 'flag_cleared'
    | 'project_verified'
    | 'project_rejected'
    | 'visibility_changed'
    | 'dossier_downloaded';
  triggeredBy: 'system' | 'admin' | 'user';
  details: Record<string, unknown>;
  suspicionScoreBefore: number | null;
  suspicionScoreAfter: number | null;
  createdAt: Date;
}

const ProfileAuditLogSchema = new Schema<IProfileAuditLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
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
      ],
      required: true,
    },
    triggeredBy: { type: String, enum: ['system', 'admin', 'user'], required: true },
    details: { type: Schema.Types.Mixed, default: {} },
    suspicionScoreBefore: { type: Number, default: null },
    suspicionScoreAfter: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ProfileAuditLogSchema.index({ userId: 1, createdAt: -1 });
ProfileAuditLogSchema.index({ eventType: 1, createdAt: -1 });
// TTL: 90 days (auto-expire old audit logs)
ProfileAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const ProfileAuditLog = mongoose.model<IProfileAuditLog>('ProfileAuditLog', ProfileAuditLogSchema);
