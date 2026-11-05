// src/db/models/mission.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IMission extends Document {
  userId: Schema.Types.ObjectId;
  title: string;
  description: string;
  type: 'daily' | 'weekly' | 'milestone';
  status: 'pending' | 'in_progress' | 'completed' | 'expired';
  targetCount: number;
  currentCount: number;
  xpReward: number;
  category: 'dsa' | 'project' | 'learning' | 'consistency';
  expiresAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

const missionSchema = new Schema<IMission>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['daily', 'weekly', 'milestone'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'expired'],
      default: 'pending',
      index: true,
    },
    targetCount: {
      type: Number,
      required: true,
    },
    currentCount: {
      type: Number,
      default: 0,
    },
    xpReward: {
      type: Number,
      required: true,
    },
    category: {
      type: String,
      enum: ['dsa', 'project', 'learning', 'consistency'],
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
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
missionSchema.index({ userId: 1, status: 1, expiresAt: 1 });
missionSchema.index({ userId: 1, type: 1 });
missionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 * 30 }); // Auto-delete after 30 days past expiry

export const Mission = model<IMission>('Mission', missionSchema);