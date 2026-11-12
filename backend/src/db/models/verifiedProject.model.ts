import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IVerifiedProject extends Document {
  userId: Types.ObjectId;
  projectId: Types.ObjectId | null;
  githubRepoId: string;
  repoFullName: string;
  repoUrl: string;

  verification: {
    status: 'pending' | 'verified' | 'rejected' | 'needs_review';
    verifiedAt: Date | null;
    rejectionReason: string | null;
    checks: {
      minCommits: boolean;
      minLocDelta: boolean;
      repoAge: boolean;
      notFork: boolean;
      notEmpty: boolean;
      notArchived: boolean;
      contributionConsistency: boolean;
      userIsContributor: boolean;
    };
  };

  metrics: {
    userCommitCount: number;
    totalCommitCount: number;
    userLocAdded: number;
    userLocDeleted: number;
    repoAgeInDays: number;
    primaryLanguage: string;
    languages: Record<string, number>;
    firstCommitAt: Date | null;
    lastCommitAt: Date | null;
    commitSpanDays: number;
    stars: number;
    forks: number;
  };

  antiGaming: {
    isCommitFarmed: boolean;
    hasEmptyCommits: boolean;
    suspicionScore: number;
  };

  provenance?: {
    source: 'github';
    checkedAt: Date;
    contributorId: string | null;
    checkedAccountId: string | null;
    isFork: boolean;
    isArchived: boolean;
    fileCount: number;
    files: string[];
    hasTests: boolean;
    hasCI: boolean;
    linkedRepoUrl?: string;
    discoveredBySync?: boolean;
  };

  name: string;
  description: string | null;
  techStack: string[];
  createdAt: Date;
  updatedAt: Date;
}

const VerifiedProjectSchema = new Schema<IVerifiedProject>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    githubRepoId: { type: String, required: true },
    repoFullName: { type: String, required: true },
    repoUrl: { type: String, required: true },

    verification: {
      status: { type: String, enum: ['pending', 'verified', 'rejected', 'needs_review'], default: 'pending' },
      verifiedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null },
      checks: {
        minCommits: { type: Boolean, default: false },
        minLocDelta: { type: Boolean, default: false },
        repoAge: { type: Boolean, default: false },
        notFork: { type: Boolean, default: false },
        notEmpty: { type: Boolean, default: false },
        notArchived: { type: Boolean, default: false },
        contributionConsistency: { type: Boolean, default: false },
        userIsContributor: { type: Boolean, default: false },
      },
    },

    metrics: {
      userCommitCount: { type: Number, default: 0 },
      totalCommitCount: { type: Number, default: 0 },
      userLocAdded: { type: Number, default: 0 },
      userLocDeleted: { type: Number, default: 0 },
      repoAgeInDays: { type: Number, default: 0 },
      primaryLanguage: { type: String, default: '' },
      languages: { type: Map, of: Number, default: {} },
      firstCommitAt: { type: Date, default: null },
      lastCommitAt: { type: Date, default: null },
      commitSpanDays: { type: Number, default: 0 },
      stars: { type: Number, default: 0 },
      forks: { type: Number, default: 0 },
    },

    antiGaming: {
      isCommitFarmed: { type: Boolean, default: false },
      hasEmptyCommits: { type: Boolean, default: false },
      suspicionScore: { type: Number, default: 0 },
    },

    provenance: {
      type: new Schema({
        source: { type: String, enum: ['github'], required: true },
        checkedAt: { type: Date, required: true },
        contributorId: { type: String, default: null },
        checkedAccountId: { type: String, default: null },
        isFork: Boolean,
        isArchived: Boolean,
        fileCount: Number,
        files: [String],
        hasTests: Boolean,
        hasCI: Boolean,
        linkedRepoUrl: String,
        discoveredBySync: Boolean,
      }, { _id: false }),
      default: undefined,
    },

    name: { type: String, required: true },
    description: { type: String, default: null },
    techStack: [{ type: String }],
  },
  { timestamps: true }
);

VerifiedProjectSchema.index({ userId: 1, githubRepoId: 1 }, { unique: true });
VerifiedProjectSchema.index({ userId: 1, 'verification.status': 1 });
VerifiedProjectSchema.index({ 'verification.status': 1, updatedAt: -1 });

export const VerifiedProject = mongoose.model<IVerifiedProject>('VerifiedProject', VerifiedProjectSchema);
