// src/db/models/renderArtifact.model.ts — Output of the render worker pool (WORKER_TYPE=render).
// One row per artifactKey. The contentHash fingerprints the data a render was built from, so a
// request whose content is unchanged is answered from the stored artifact instead of rendering again.

import mongoose, { Schema, type Document, type Types } from 'mongoose';

export const RENDER_ARTIFACT_TYPES = ['og_image', 'pdf_dossier'] as const;
export type RenderArtifactType = (typeof RENDER_ARTIFACT_TYPES)[number];

export const RENDER_ARTIFACT_STATUSES = ['pending', 'ready', 'failed'] as const;
export type RenderArtifactStatus = (typeof RENDER_ARTIFACT_STATUSES)[number];

export interface IRenderArtifact extends Document {
  /** Stable identity of the thing rendered, for example `og_image:<userId>`. Unique. */
  artifactKey: string;
  userId: Types.ObjectId;
  type: RenderArtifactType;
  /** SHA-256 of the render input. A different hash means the stored bytes are stale. */
  contentHash: string;
  status: RenderArtifactStatus;
  /** Where the bytes live when they are kept in object storage. Null for inline artifacts. */
  storageUrl: string | null;
  /** Inline bytes for small artifacts (OG cards are a few tens of KB). Not loaded unless asked for. */
  content?: Buffer;
  contentType: string;
  byteLength: number;
  error: string | null;
  renderedAt: Date | null;
  /** The row is removed by the TTL index after this instant. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const renderArtifactSchema = new Schema<IRenderArtifact>(
  {
    artifactKey: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true, enum: RENDER_ARTIFACT_TYPES },
    contentHash: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    status: { type: String, required: true, enum: RENDER_ARTIFACT_STATUSES, default: 'pending' },
    storageUrl: { type: String, default: null },
    content: { type: Buffer, select: false },
    contentType: { type: String, required: true },
    byteLength: { type: Number, default: 0, min: 0 },
    error: { type: String, default: null },
    renderedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

renderArtifactSchema.index({ artifactKey: 1 }, { unique: true, name: 'uq_renderartifacts_key' });
// Everything a user has rendered, for cleanup when they unpublish or delete their account.
renderArtifactSchema.index({ userId: 1, type: 1 }, { name: 'idx_renderartifacts_user_type' });
renderArtifactSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_renderartifacts_expires' });

export const RenderArtifact = mongoose.model<IRenderArtifact>('RenderArtifact', renderArtifactSchema);
