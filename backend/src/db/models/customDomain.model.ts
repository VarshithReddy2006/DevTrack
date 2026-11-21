import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * pending   registered, DNS not checked yet
 * active    TXT challenge and CNAME verified, the domain may route to the portfolio
 * failed    the last verification attempt did not find the right records
 * suspended was active, then a re-check found the records gone; needs a new verify
 */
export const CUSTOM_DOMAIN_STATUSES = ['pending', 'active', 'failed', 'suspended'] as const;
export type CustomDomainStatus = typeof CUSTOM_DOMAIN_STATUSES[number];

export const CUSTOM_DOMAIN_ERROR_CODES = [
  'TXT_MISSING', 'TXT_MISMATCH', 'CNAME_MISSING', 'CNAME_MISMATCH', 'DNS_TIMEOUT', 'DNS_ERROR', 'DOMAIN_TAKEN',
] as const;
export type CustomDomainErrorCode = typeof CUSTOM_DOMAIN_ERROR_CODES[number];

export interface ICustomDomain extends Document {
  userId: Types.ObjectId;
  /** Lowercase hostname without a trailing dot, e.g. portfolio.alexchen.dev. */
  domain: string;
  /** Value the owner publishes as the TXT record at _devtrack-challenge.<domain>. */
  verificationToken: string;
  status: CustomDomainStatus;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  suspendedAt: Date | null;
  lastError: { code: CustomDomainErrorCode; message: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

const customDomainSchema = new Schema<ICustomDomain>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    domain: { type: String, required: true, lowercase: true, trim: true, maxlength: 253 },
    verificationToken: { type: String, required: true },
    status: { type: String, enum: CUSTOM_DOMAIN_STATUSES, default: 'pending', required: true },
    verifiedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    lastError: {
      type: new Schema({
        code: { type: String, enum: CUSTOM_DOMAIN_ERROR_CODES, required: true },
        message: { type: String, required: true },
      }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true },
);

// One custom domain per profile.
customDomainSchema.index({ userId: 1 }, { name: 'uq_customdomains_user', unique: true });
// A domain can route to one profile only. Pending registrations do not count, so nobody can
// block a domain they do not control by registering it first: whoever passes the TXT challenge wins.
customDomainSchema.index(
  { domain: 1 },
  { name: 'uq_customdomains_active_domain', unique: true, partialFilterExpression: { status: 'active' } },
);
// Weekly re-check: active domains, least recently checked first.
customDomainSchema.index({ status: 1, lastCheckedAt: 1 }, { name: 'idx_customdomains_status_checked' });

export const CustomDomain = mongoose.model<ICustomDomain>('CustomDomain', customDomainSchema);
