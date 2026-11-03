// src/db/models/user.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IUser extends Document {
  clerkId: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  timezone: string;
  joinedAt: Date;
  lastActiveAt: Date;
  isEmailVerified: boolean;
  role: 'user' | 'admin';
}

const userSchema = new Schema<IUser>(
  {
    clerkId: {
      type: String,
      required: true,
      unique: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      trim: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username must be at most 30 characters'],
    },
    displayName: {
      type: String,
      required: [true, 'Display name is required'],
      trim: true,
      maxlength: [100, 'Display name must be at most 100 characters'],
    },
    avatarUrl: {
      type: String,
      default: null,
    },
    bio: {
      type: String,
      default: null,
      maxlength: [500, 'Bio must be at most 500 characters'],
    },
    timezone: {
      type: String,
      default: 'UTC',
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
  },
  {
    timestamps: { createdAt: 'joinedAt', updatedAt: 'lastActiveAt' },
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

// Indexes - unique indexes already defined via index:true in field definitions

export const User = model<IUser>('User', userSchema);