import { Schema, model, type Document } from 'mongoose';

export type ConceptDomain = 'system-design' | 'cs-concepts';
export type ConceptConfidence = 'got_it' | 'revise_again';

export interface IUserConceptProgress extends Document {
  userId: string;
  domain: ConceptDomain;
  conceptId: string;
  completed: boolean;
  confidence: ConceptConfidence | null;
  updatedAt: Date;
}

const userConceptProgressSchema = new Schema<IUserConceptProgress>(
  {
    userId: { type: String, required: true, index: true },
    domain: { type: String, enum: ['system-design', 'cs-concepts'], required: true },
    conceptId: { type: String, required: true },
    completed: { type: Boolean, required: true, default: false },
    confidence: {
      type: String,
      enum: ['got_it', 'revise_again'],
      default: null,
    },
  },
  { timestamps: true }
);

userConceptProgressSchema.index({ userId: 1, domain: 1, conceptId: 1 }, { unique: true });

export const UserConceptProgress = model<IUserConceptProgress>(
  'UserConceptProgress',
  userConceptProgressSchema
);
