// src/db/models/userProfile.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IUserProfile extends Document {
  userId: Schema.Types.ObjectId;
  roleTitle: string | null;
  location: string | null;
  targetRole: string | null;
  targetCompanies: string[];
  techStack: string[];
  socialLinks: {
    github: string | null;
    linkedin: string | null;
    twitter: string | null;
    portfolio: string | null;
    leetcode: string | null;
    codeforces: string | null;
    codechef: string | null;
  };
  updatedAt: Date;
}

const userProfileSchema = new Schema<IUserProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    roleTitle: {
      type: String,
      default: null,
    },
    location: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    targetRole: {
      type: String,
      default: null,
    },
    targetCompanies: {
      type: [String],
      default: [],
    },
    techStack: {
      type: [String],
      default: [],
    },
    socialLinks: {
      github: { type: String, default: null },
      linkedin: { type: String, default: null },
      twitter: { type: String, default: null },
      portfolio: { type: String, default: null },
      leetcode: { type: String, default: null },
      codeforces: { type: String, default: null },
      codechef: { type: String, default: null },
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

export const UserProfile = model<IUserProfile>('UserProfile', userProfileSchema);
