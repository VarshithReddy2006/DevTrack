import { Schema, model, Document } from 'mongoose';

export interface IUserSkillProgress extends Document {
  userId: string;
  skill: string;
  completed: boolean;
  completedAt?: Date;
  source?: 'manual' | 'roadmap';
}

const userSkillProgressSchema = new Schema<IUserSkillProgress>(
  {
    userId: { type: String, required: true, index: true },
    skill: { type: String, required: true },
    completed: { type: Boolean, required: true, default: false },
    completedAt: { type: Date },
    source: { type: String, enum: ['manual', 'roadmap'], default: 'manual' },
  },
  { timestamps: true }
);

// Compound index to ensure uniqueness per user per skill
userSkillProgressSchema.index({ userId: 1, skill: 1 }, { unique: true });

export const UserSkillProgress = model<IUserSkillProgress>('UserSkillProgress', userSkillProgressSchema);
