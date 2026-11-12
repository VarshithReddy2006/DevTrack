import { Schema, model } from 'mongoose';
import type { EvidenceChain, EvidenceLink, EvidenceNode } from '../../modules/operations/EvidenceChainSystem.js';

const nodeSchema = new Schema<EvidenceNode>({
  evidenceId: { type: String, required: true },
  source: String,
  type: String,
  timestamp: Date,
  data: Schema.Types.Mixed,
  confidence: Number,
}, { _id: false, minimize: false });

const linkSchema = new Schema<EvidenceLink>({
  insightId: { type: String, required: true },
  insightType: String,
  evidenceIds: [String],
  reasoning: String,
  contributionWeight: Number,
}, { _id: false });

const schema = new Schema<EvidenceChain>({
  chainId: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  rootInsight: String,
  nodes: [nodeSchema],
  links: [linkSchema],
  createdAt: { type: Date, required: true },
  isComplete: { type: Boolean, default: false },
}, { minimize: false, versionKey: false });

schema.index({ userId: 1, createdAt: -1 });
schema.index({ 'links.insightId': 1 });
schema.index({ 'nodes.evidenceId': 1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

export const EvidenceChainRecord = model<EvidenceChain>('EvidenceChainRecord', schema);
