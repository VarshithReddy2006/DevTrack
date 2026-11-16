// src/db/models/processedEvent.model.ts — Global event idempotency layer
// Prevents duplicate processing across all workers via inbox pattern

import mongoose, { Schema, type Document } from 'mongoose';

export interface IProcessedEvent extends Document {
  consumer: string;
  eventId: string;
  eventType?: string;
  userId?: Schema.Types.ObjectId;
  processedAt: Date;
  ttlExpiresAt?: Date;
  result?: {
    success: boolean;
    details?: string;
  };
}

const processedEventSchema = new Schema<IProcessedEvent>(
  {
    consumer: { type: String, required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: false },
    userId: { type: Schema.Types.ObjectId, required: false },
    processedAt: { type: Date, required: true, default: Date.now },
    ttlExpiresAt: { type: Date, required: false },
    result: {
      success: { type: Boolean, required: false },
      details: { type: String },
    },
  },
  {
    timestamps: false,
    optimisticConcurrency: false,
  }
);

// Compound unique index for consumer inbox deduplication
processedEventSchema.index(
  { consumer: 1, eventId: 1 },
  { unique: true, name: 'uq_processedevents_consumer_event' }
);

// TTL index for automatic cleanup (events expire after 7 days)
processedEventSchema.index(
  { ttlExpiresAt: 1 },
  { expireAfterSeconds: 0 }
);

// Query indexes
processedEventSchema.index({ eventId: 1, eventType: 1 });
processedEventSchema.index({ userId: 1, processedAt: -1 });
processedEventSchema.index({ eventType: 1, processedAt: -1 });

// Static methods for idempotency checks
processedEventSchema.statics.checkAndMark = async function (
  eventId: string,
  eventType: string,
  userId: string | mongoose.Types.ObjectId,
  ttlDays = 7,
  consumer = 'default'
): Promise<{ alreadyProcessed: boolean; existingEvent?: IProcessedEvent }> {
  const userObjId = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;

  // Try to find existing event
  const existing = await this.findOne({ consumer, eventId });

  if (existing) {
    return { alreadyProcessed: true, existingEvent: existing };
  }

  // Create new processed event atomically
  const ttlExpiresAt = new Date();
  ttlExpiresAt.setDate(ttlExpiresAt.getDate() + ttlDays);

  try {
    await this.create({
      consumer,
      eventId,
      eventType,
      userId: userObjId,
      processedAt: new Date(),
      ttlExpiresAt,
      result: { success: true },
    });
    return { alreadyProcessed: false };
  } catch (err: unknown) {
    // Duplicate key error means another worker already processed this
    if ((err as { code?: number })?.code === 11000) {
      const concurrentEvent = await this.findOne({ consumer, eventId });
      return { alreadyProcessed: true, existingEvent: concurrentEvent };
    }
    throw err;
  }
};

processedEventSchema.statics.markFailed = async function (
  eventId: string,
  eventType: string,
  userId: string | mongoose.Types.ObjectId,
  errorDetails: string,
  consumer = 'default'
): Promise<void> {
  const userObjId = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;

  const ttlExpiresAt = new Date();
  ttlExpiresAt.setDate(ttlExpiresAt.getDate() + 7);

  try {
    await this.findOneAndUpdate(
      { consumer, eventId },
      {
        $setOnInsert: {
          consumer,
          eventId,
          eventType,
          userId: userObjId,
          processedAt: new Date(),
          ttlExpiresAt,
        },
        $set: {
          result: { success: false, details: errorDetails },
        },
      },
      { upsert: true, lean: true }
    );
  } catch (err) {
    const { logger } = await import('../../shared/logger.js');
    logger.warn('[ProcessedEvent] Failed to mark event as failed', { consumer, eventId, eventType, error: err instanceof Error ? err.message : String(err) });
  }
};

export const ProcessedEvent = mongoose.model<IProcessedEvent>('ProcessedEvent', processedEventSchema);
