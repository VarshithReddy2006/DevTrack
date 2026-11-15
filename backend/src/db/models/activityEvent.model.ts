// src/db/models/activityEvent.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IActivityEvent extends Document {
  userId: Schema.Types.ObjectId;
  type: 'problem_solved' | 'commit_pushed' | 'pr_merged' | 'project_created' | 'project_updated' | 'project_deleted' | 'contest_participated' | 'streak_milestone' | 'note_added' | 'settings_updated' | 'github_sync_completed' | 'focus_session';
  title: string;
  description: string;
  platform: string;
  url: string | null;
  tags: string[];
  metadata: Record<string, string | number | boolean>;
  occurredAt: Date;
  createdAt: Date;
}

const activityEventSchema = new Schema<IActivityEvent>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['problem_solved', 'commit_pushed', 'pr_merged', 'project_created', 'project_updated', 'project_deleted', 'contest_participated', 'streak_milestone', 'note_added', 'settings_updated', 'github_sync_completed', 'focus_session'],
      required: true,
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
    platform: {
      type: String,
      required: true,
      index: true,
    },
    url: {
      type: String,
      default: null,
    },
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    occurredAt: {
      type: Date,
      required: true,
      index: true,
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
activityEventSchema.index({ userId: 1, occurredAt: -1 });
activityEventSchema.index({ userId: 1, platform: 1, occurredAt: -1 });
activityEventSchema.index({ userId: 1, type: 1, occurredAt: -1 });
activityEventSchema.index({ userId: 1, tags: 1 });

export const ActivityEvent = model<IActivityEvent>('ActivityEvent', activityEventSchema);