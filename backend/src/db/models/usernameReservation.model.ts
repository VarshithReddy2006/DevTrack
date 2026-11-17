import mongoose, { Document, Schema, Types } from 'mongoose';

export type UsernameReservationStatus = 'active' | 'released' | 'reserved_system';

/** Handles that point at application or API paths and can never be claimed as a vanity URL. */
export const RESERVED_SLUGS: readonly string[] = [
  'about', 'achievements', 'admin', 'api', 'assets', 'beta', 'challenges', 'contests', 'dashboard',
  'devtrack', 'dsa', 'focus', 'goals', 'health', 'help', 'interview', 'leaderboard', 'login', 'logout',
  'metrics', 'notifications', 'portfolio', 'privacy', 'profile', 'projects', 'readiness', 'resume',
  'settings', 'signup', 'static', 'support', 'system', 'terms', 'u', 'www',
];

/** 3 to 30 characters, lowercase letters, digits and inner hyphens. Matches the /u/:slug route limits. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export interface IUsernameReservation extends Document {
  slug: string;
  userId: Types.ObjectId | null;
  status: UsernameReservationStatus;
  createdAt: Date;
}

/** Index specs live here so the schema and the migration cannot drift apart. */
export const USERNAME_RESERVATION_INDEXES = {
  slug: { key: { slug: 1 }, options: { name: 'slug_unique', unique: true } },
  activeUser: {
    key: { userId: 1 },
    options: { name: 'one_active_slug_per_user', unique: true, partialFilterExpression: { status: 'active' } },
  },
} as const;

const UsernameReservationSchema = new Schema<IUsernameReservation>(
  {
    slug: { type: String, required: true, lowercase: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['active', 'released', 'reserved_system'], default: 'active', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

for (const { key, options } of Object.values(USERNAME_RESERVATION_INDEXES)) {
  UsernameReservationSchema.index(key, options);
}

export const UsernameReservation = mongoose.model<IUsernameReservation>('UsernameReservation', UsernameReservationSchema);
