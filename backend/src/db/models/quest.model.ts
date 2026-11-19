import mongoose, { Schema } from 'mongoose';
import { LEAGUE_DIVISIONS, type LeagueDivision } from './leagueStanding.model.js';

export type QuestKind = 'dsa_solve' | 'focus_minutes' | 'revision_review';
export interface IQuest {
  key: string;
  slot: string;
  cadence: 'daily' | 'weekly';
  division: LeagueDivision;
  kind: QuestKind;
  title: string;
  targetCount: number;
  xpReward: number;
  trophyReward: number;
}
const schema = new Schema<IQuest>({
  key: { type: String, required: true, unique: true },
  slot: { type: String, required: true },
  cadence: { type: String, enum: ['daily', 'weekly'], required: true },
  division: { type: String, enum: LEAGUE_DIVISIONS, required: true },
  kind: { type: String, enum: ['dsa_solve', 'focus_minutes', 'revision_review'], required: true },
  title: { type: String, required: true },
  targetCount: { type: Number, required: true, min: 1 },
  xpReward: { type: Number, required: true, min: 1 },
  trophyReward: { type: Number, required: true, min: 1 },
});
export const Quest = mongoose.model<IQuest>('Quest', schema);
