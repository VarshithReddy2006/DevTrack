import mongoose, { Schema, Document } from 'mongoose';

export interface ICareerIntent extends Document {
  userId: string;
  dreamRole: string; // e.g., 'Backend Engineer', 'Full Stack Engineer'
  targetPackage: string; // e.g., '20 LPA', 'FAANG'
  targetCompanyTier: string;
  preferredDomain: string;
  currentStrongestSkills: string[];
  desiredSkills: string[];
  specializationGoals: string[];
  timelineGoals: string; // e.g., '6 months', '1 year'
  confidenceState: 'high' | 'medium' | 'low';
  goal?: string; // e.g., 'First Job'
  experienceLevel?: string; // e.g., 'Beginner'
  weeklyHours?: number; // e.g., 10
  history: Array<{
    role: string;
    package: string;
    recordedAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const CareerIntentSchema = new Schema<ICareerIntent>(
  {
    userId: { type: String, required: true, unique: true },
    dreamRole: { type: String, required: true },
    targetPackage: { type: String, default: '' },
    targetCompanyTier: { type: String, default: '' },
    preferredDomain: { type: String, default: '' },
    currentStrongestSkills: [{ type: String }],
    desiredSkills: [{ type: String }],
    specializationGoals: [{ type: String }],
    timelineGoals: { type: String, default: '' },
    confidenceState: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
    goal: { type: String, default: '' },
    experienceLevel: { type: String, default: '' },
    weeklyHours: { type: Number, default: 0 },
    history: [
      {
        role: { type: String },
        package: { type: String },
        recordedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export const CareerIntent = mongoose.model<ICareerIntent>('CareerIntent', CareerIntentSchema);

