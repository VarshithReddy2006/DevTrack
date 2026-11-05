// src/db/models/userSettings.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IPlatform {
  username?: string;
  handle?: string;
  lastSyncedAt: Date | null;
}

export interface IUserSettings extends Document {
  userId: Schema.Types.ObjectId;
  platforms: {
    github: IPlatform;
    codeforces: IPlatform;
    leetcode: IPlatform;
    codechef: IPlatform;
  };
  notifications: {
    emailNotifications: boolean;
    pushNotifications: boolean;
    dailyDigest: boolean;
    weeklyReport: boolean;
    streakReminder: boolean;
    missionAlerts: boolean;
    projectUpdates: boolean;
  };
  appearance: {
    theme: 'light' | 'dark' | 'system';
    accentColor: string;
    compactMode: boolean;
    showHeatmap: boolean;
    heatmapColor: string;
    language: string;
  };
  privacy: {
    profileVisibility: 'public' | 'private' | 'recruiter_only';
    showActivity: boolean;
    showStreak: boolean;
    showProjects: boolean;
    showDsaProgress: boolean;
    showGithub: boolean;
    showTimeline: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

const platformSchema = new Schema<IPlatform>({
  username: { type: String, default: '' },
  handle: { type: String, default: '' },
  lastSyncedAt: { type: Date, default: null },
}, { _id: false });

const userSettingsSchema = new Schema<IUserSettings>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    platforms: {
      github: { type: platformSchema, default: () => ({}) },
      codeforces: { type: platformSchema, default: () => ({}) },
      leetcode: { type: platformSchema, default: () => ({}) },
      codechef: { type: platformSchema, default: () => ({}) },
    },
    notifications: {
      emailNotifications: { type: Boolean, default: true },
      pushNotifications: { type: Boolean, default: true },
      dailyDigest: { type: Boolean, default: true },
      weeklyReport: { type: Boolean, default: true },
      streakReminder: { type: Boolean, default: true },
      missionAlerts: { type: Boolean, default: true },
      projectUpdates: { type: Boolean, default: true },
    },
    appearance: {
      theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
      accentColor: { type: String, default: '#3b82f6' },
      compactMode: { type: Boolean, default: false },
      showHeatmap: { type: Boolean, default: true },
      heatmapColor: { type: String, default: 'green' },
      language: { type: String, default: 'en' },
    },
    privacy: {
      profileVisibility: { type: String, enum: ['public', 'private', 'recruiter_only'], default: 'public' },
      showActivity: { type: Boolean, default: true },
      showStreak: { type: Boolean, default: true },
      showProjects: { type: Boolean, default: true },
      showDsaProgress: { type: Boolean, default: true },
      showGithub: { type: Boolean, default: true },
      showTimeline: { type: Boolean, default: true },
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

// Indexes: userId is unique-indexed on the field itself, so it is not repeated here.

export const UserSettings = model<IUserSettings>('UserSettings', userSettingsSchema);