// src/db/models/careerRoadmap.model.ts — a generated learning roadmap for one target role.
// One document per user: generating a new roadmap replaces the previous one. Milestones are
// 2-week blocks; only task completion is stored, milestone and roadmap progress are derived.
import { Schema, model, type Document, type Types } from 'mongoose';

export type RoadmapTaskKind = 'learn' | 'build' | 'practice' | 'verify';
export type RoadmapSource = 'ai' | 'template';
export type RoadmapTargetSource = 'job_target' | 'role_catalog';
/** Why a roadmap came from the template. Stored so a degraded generation is never silent. */
export type RoadmapDegradedReason = 'ai_unconfigured' | 'llm_failed' | 'invalid_output' | 'quota_exceeded';

export interface ICareerRoadmapTask {
  taskId: string;
  kind: RoadmapTaskKind;
  title: string;
  completed: boolean;
  completedAt: Date | null;
}

export interface ICareerRoadmapMilestone {
  milestoneId: string;
  sequence: number;
  startWeek: number;
  endWeek: number;
  skills: string[];
  objective: string;
  projectArchitecture: string;
  keyConcepts: string[];
  dsaPatterns: string[];
  verificationCriteria: string[];
  tasks: ICareerRoadmapTask[];
}

export interface ICareerRoadmap extends Document {
  userId: Types.ObjectId;
  targetRoleId: string;
  targetRole: string;
  targetSource: RoadmapTargetSource;
  targetDeadlineWeeks: number;
  /** ReadinessCore.overallScore when the roadmap was generated, or null if none was computed yet. */
  baselineReadinessScore: number | null;
  missingSkills: string[];
  /** Missing skills that did not fit before the deadline. */
  deferredSkills: string[];
  source: RoadmapSource;
  degradedReason: RoadmapDegradedReason | null;
  milestones: ICareerRoadmapMilestone[];
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const taskSchema = new Schema<ICareerRoadmapTask>(
  {
    taskId: { type: String, required: true },
    kind: { type: String, enum: ['learn', 'build', 'practice', 'verify'], required: true },
    title: { type: String, required: true },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
  },
  { _id: false },
);

const milestoneSchema = new Schema<ICareerRoadmapMilestone>(
  {
    milestoneId: { type: String, required: true },
    sequence: { type: Number, required: true },
    startWeek: { type: Number, required: true },
    endWeek: { type: Number, required: true },
    skills: { type: [String], default: [] },
    objective: { type: String, required: true },
    projectArchitecture: { type: String, required: true },
    keyConcepts: { type: [String], default: [] },
    dsaPatterns: { type: [String], default: [] },
    verificationCriteria: { type: [String], default: [] },
    tasks: { type: [taskSchema], default: [] },
  },
  { _id: false },
);

const careerRoadmapSchema = new Schema<ICareerRoadmap>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    targetRoleId: { type: String, required: true },
    targetRole: { type: String, required: true },
    targetSource: { type: String, enum: ['job_target', 'role_catalog'], required: true },
    targetDeadlineWeeks: { type: Number, required: true, min: 1 },
    baselineReadinessScore: { type: Number, default: null },
    missingSkills: { type: [String], default: [] },
    deferredSkills: { type: [String], default: [] },
    source: { type: String, enum: ['ai', 'template'], required: true },
    degradedReason: { type: String, enum: ['ai_unconfigured', 'llm_failed', 'invalid_output', 'quota_exceeded', null], default: null },
    milestones: { type: [milestoneSchema], default: [] },
    generatedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export const CareerRoadmap = model<ICareerRoadmap>('CareerRoadmap', careerRoadmapSchema);
