// src/db/models/projectTask.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IProjectTask extends Document {
  projectId: Schema.Types.ObjectId;
  milestoneId: string | null;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'critical';
  assigneeId: string | null;
  labels: string[];
  dueDate: Date | null;
  completedAt: Date | null;
  rank: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const projectTaskSchema = new Schema<IProjectTask>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    milestoneId: {
      type: String,
      default: null,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['todo', 'in_progress', 'review', 'done'],
      default: 'todo',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
      index: true,
    },
    assigneeId: {
      type: String,
      default: null,
    },
    labels: {
      type: [String],
      default: [],
    },
    dueDate: {
      type: Date,
      default: null,
      index: true,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    // Fractional-index position inside a board column; see rankBetween().
    rank: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete (ret as { _id?: unknown })._id;
        delete (ret as { __v?: unknown }).__v;
        return ret;
      },
    },
  }
);

// Indexes
projectTaskSchema.index({ projectId: 1, status: 1, priority: 1, dueDate: 1 });
projectTaskSchema.index({ projectId: 1, milestoneId: 1 });
projectTaskSchema.index({ projectId: 1, status: 1, rank: 1 });

// ─── Fractional ranks ──────────────────────────────────────────────────────
// A task's place in a column is a string that sorts (plain string comparison)
// between its neighbours. Moving a task only writes that one document: pick a
// rank between the new neighbours instead of renumbering everything after it.

const RANK_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANK_BASE = RANK_DIGITS.length;

/**
 * Return a rank that sorts strictly after `prev` and strictly before `next`.
 * Pass null for an open end (top of the column: prev = null, bottom: next = null).
 * Generated ranks never end in '0', so there is always room between two of them.
 * A short random suffix makes two concurrent moves into the same gap unlikely
 * to land on the same rank; readers also tie-break on _id.
 */
export function rankBetween(
  prev: string | null,
  next: string | null,
  random: () => number = Math.random
): string {
  const a = prev ?? '';
  const b = next ?? '';
  if (b !== '' && a >= b) {
    throw new Error('prev rank must sort before next rank');
  }

  let bounded = b !== '';
  let out = '';
  for (let i = 0; ; i++) {
    if (bounded && i >= b.length) {
      throw new Error('next rank has no room before it');
    }
    const lo = i < a.length ? RANK_DIGITS.indexOf(a[i]) : 0;
    const hi = bounded ? RANK_DIGITS.indexOf(b[i]) : RANK_BASE;
    if (lo < 0 || hi < 0) {
      throw new Error('rank contains an unsupported character');
    }
    if (hi - lo > 1) {
      out += RANK_DIGITS[Math.floor((lo + hi) / 2)];
      break;
    }
    out += RANK_DIGITS[lo];
    if (hi - lo === 1) bounded = false;
  }

  for (let n = 0; n < 2; n++) {
    out += RANK_DIGITS[1 + Math.floor(random() * (RANK_BASE - 1))];
  }
  return out;
}

export const ProjectTask = model<IProjectTask>('ProjectTask', projectTaskSchema);