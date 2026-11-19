import { Schema, type Types } from 'mongoose';

export const MAX_INTERVIEW_TURNS = 6;
export const INTERVIEW_WARNING_MS = 40 * 60_000;
export const INTERVIEW_TIMEOUT_MS = 45 * 60_000;
export const INTERVIEW_INACTIVE_MS = 2 * 60 * 60_000;

/** Fields required of the owning #347 session model; this module does not register a competing model. */
export interface GuardedInterviewSession {
  _id: Types.ObjectId;
  userId: string;
  status: 'in_progress' | 'completed' | 'abandoned' | 'expired';
  state: string;
  stateVersion: number;
  startedAt: Date;
  lastActivityAt: Date;
  turnsCount: number;
  maxTurns: number;
  closedAt: Date | null;
  guard: {
    reason: 'timeout' | 'inactive' | null;
    warningAt: Date | null;
    warningPending: boolean;
    evaluationPending: boolean;
    deliveryToken: string | null;
    deliveryLeaseUntil: Date;
  };
}

/** Apply before compiling the owning session model. Counters/timestamps are server-owned. */
export function addInterviewGuardFields(schema: Schema): void {
  schema.add({
    startedAt: { type: Date, required: true, default: Date.now },
    lastActivityAt: { type: Date, required: true, default: Date.now },
    turnsCount: { type: Number, required: true, default: 0, min: 0, max: MAX_INTERVIEW_TURNS, validate: Number.isInteger },
    maxTurns: { type: Number, required: true, default: MAX_INTERVIEW_TURNS, min: 1, max: MAX_INTERVIEW_TURNS, validate: Number.isInteger },
    closedAt: { type: Date, default: null },
    guard: { type: new Schema({
      reason: { type: String, enum: ['timeout', 'inactive', null], default: null },
      warningAt: { type: Date, default: null },
      warningPending: { type: Boolean, default: false },
      evaluationPending: { type: Boolean, default: false },
      deliveryToken: { type: String, default: null },
      deliveryLeaseUntil: { type: Date, default: () => new Date(0) },
    }, { _id: false }), required: true, default: () => ({}) },
  });
  schema.index({ status: 1, startedAt: 1 });
  schema.index({ status: 1, lastActivityAt: 1 });
  schema.index({ 'guard.warningPending': 1, 'guard.deliveryLeaseUntil': 1 });
  schema.index({ 'guard.evaluationPending': 1, 'guard.deliveryLeaseUntil': 1 });
}
