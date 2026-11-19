import { Schema, model } from 'mongoose';

const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  contestId: { type: Schema.Types.ObjectId, required: true, ref: 'DsaContest' },
  platform: { type: String, enum: ['codeforces', 'leetcode'], required: true },
  handle: { type: String, required: true },
  rank: { type: Number, default: null },
  score: { type: Number, default: null },
  problemsSolved: { type: Number, required: true, min: 0 },
  ratingBefore: { type: Number, default: null },
  ratingAfter: { type: Number, default: null },
  ratingChange: { type: Number, default: null },
  observedAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ userId: 1, contestId: 1 }, { unique: true });
schema.index({ userId: 1, platform: 1, observedAt: -1 });

export const DsaContestParticipation = model('DsaContestParticipation', schema);
