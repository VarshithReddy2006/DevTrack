// src/shared/events/runConsumer.ts — Domain event consumer runner with inbox deduplication
// Implements transactional ProcessedEvent checks to guarantee idempotent processing.

import mongoose, { type ClientSession, Types } from 'mongoose';
import { ProcessedEvent } from '../../db/models/processedEvent.model.js';
import { logger } from '../logger.js';
import type { DomainEventEnvelope } from './eventContract.js';
import type { ConsumerDefinition } from './consumerRegistry.js';
import { consumerRegistry } from './consumerRegistry.js';

export interface RunConsumerResult {
  consumerName: string;
  eventId: string;
  eventType: string;
  executed: boolean;
  skipped: boolean;
  reason: 'executed' | 'duplicate_inbox' | 'error';
}

class DuplicateInboxError extends Error {
  constructor() {
    super('Duplicate event detected in inbox');
    this.name = 'DuplicateInboxError';
  }
}

/**
 * Runs a single consumer against an incoming domain event envelope.
 * For 'natural' dedup consumers, it executes the handler directly.
 * For 'inbox' dedup consumers, it records the event in ProcessedEvent atomically.
 * If a duplicate key error (11000) occurs, execution is safely skipped without throwing.
 */
export async function runConsumer<P = unknown>(
  consumer: ConsumerDefinition<P>,
  event: DomainEventEnvelope<any, P>
): Promise<RunConsumerResult> {
  const { name: consumerName, dedup } = consumer;
  const eventId = event.id;
  const eventType = event.type;

  // Natural deduplication: delegate idempotency to the domain entity/handler directly
  if (dedup === 'natural') {
    try {
      await consumer.handle(event);
      return {
        consumerName,
        eventId,
        eventType,
        executed: true,
        skipped: false,
        reason: 'executed',
      };
    } catch (error) {
      logger.error('[runConsumer] Consumer execution failed (natural dedup)', {
        consumer: consumerName,
        eventId,
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Inbox deduplication: use transactional ProcessedEvent inbox record
  let session: ClientSession | null = null;
  try {
    session = await mongoose.startSession();
  } catch {
    session = null;
  }

  if (session) {
    try {
      await session.withTransaction(async () => {
        // Fast-path duplicate check within session
        const existing = await ProcessedEvent.findOne({
          consumer: consumerName,
          eventId,
        }).session(session);

        if (existing) {
          throw new DuplicateInboxError();
        }

        try {
          await ProcessedEvent.create(
            [
              {
                consumer: consumerName,
                eventId,
                eventType,
                userId: event.userId && Types.ObjectId.isValid(event.userId)
                  ? new Types.ObjectId(event.userId)
                  : undefined,
                processedAt: new Date(),
                ttlExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                result: { success: true },
              },
            ],
            { session }
          );
        } catch (err: unknown) {
          const code = (err as { code?: number })?.code;
          const message = (err as Error)?.message || '';
          if (code === 11000 || message.includes('E11000') || message.includes('duplicate key')) {
            throw new DuplicateInboxError();
          }
          throw err;
        }

        await consumer.handle(event, session);
      });

      return {
        consumerName,
        eventId,
        eventType,
        executed: true,
        skipped: false,
        reason: 'executed',
      };
    } catch (error: unknown) {
      if (error instanceof DuplicateInboxError) {
        logger.info('[runConsumer] Duplicate event detected in inbox; skipping consumer', {
          consumer: consumerName,
          eventId,
          eventType,
        });
        return {
          consumerName,
          eventId,
          eventType,
          executed: false,
          skipped: true,
          reason: 'duplicate_inbox',
        };
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      if (
        errMsg.includes('Transaction numbers are only allowed on a replica set member') ||
        errMsg.includes('This MongoDB deployment does not support transactions')
      ) {
        logger.debug('[runConsumer] Replica set transactions unavailable, falling back to standalone inbox check');
        return executeInboxNonTransactional(consumer, event);
      }

      logger.error('[runConsumer] Consumer transaction failed', {
        consumer: consumerName,
        eventId,
        eventType,
        error: errMsg,
      });
      throw error;
    } finally {
      await session.endSession();
    }
  } else {
    return executeInboxNonTransactional(consumer, event);
  }
}

/**
 * Fallback execution for standalone MongoDB environments without replica set support.
 * Acquires an optimistic inbox lock in ProcessedEvent, executes the handler, and
 * deletes the record if the handler throws an error so that queue retries are not lost.
 */
export async function executeInboxNonTransactional<P>(
  consumer: ConsumerDefinition<P>,
  event: DomainEventEnvelope<any, P>
): Promise<RunConsumerResult> {
  const { name: consumerName } = consumer;
  const eventId = event.id;
  const eventType = event.type;

  const existing = await ProcessedEvent.findOne({ consumer: consumerName, eventId });
  if (existing) {
    logger.info('[runConsumer] Duplicate event detected in inbox; skipping consumer', {
      consumer: consumerName,
      eventId,
      eventType,
    });
    return {
      consumerName,
      eventId,
      eventType,
      executed: false,
      skipped: true,
      reason: 'duplicate_inbox',
    };
  }

  try {
    await ProcessedEvent.create({
      consumer: consumerName,
      eventId,
      eventType,
      userId: event.userId && Types.ObjectId.isValid(event.userId)
        ? new Types.ObjectId(event.userId)
        : undefined,
      processedAt: new Date(),
      ttlExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      result: { success: true },
    });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    const message = (err as Error)?.message || '';
    if (code === 11000 || message.includes('E11000') || message.includes('duplicate key')) {
      logger.info('[runConsumer] Duplicate event detected in inbox; skipping consumer', {
        consumer: consumerName,
        eventId,
        eventType,
      });
      return {
        consumerName,
        eventId,
        eventType,
        executed: false,
        skipped: true,
        reason: 'duplicate_inbox',
      };
    }
    throw err;
  }

  try {
    await consumer.handle(event);
    return {
      consumerName,
      eventId,
      eventType,
      executed: true,
      skipped: false,
      reason: 'executed',
    };
  } catch (error) {
    logger.error('[runConsumer] Consumer execution failed', {
      consumer: consumerName,
      eventId,
      eventType,
      error: error instanceof Error ? error.message : String(error),
    });
    // Remove optimistic inbox record so subsequent retries are not permanently dropped as duplicates
    try {
      await ProcessedEvent.deleteOne({ consumer: consumerName, eventId });
    } catch (cleanupErr) {
      logger.error('[runConsumer] Failed to clean up ProcessedEvent after handler failure', {
        consumer: consumerName,
        eventId,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    throw error;
  }
}

/**
 * Dispatches an event to all consumers registered in consumerRegistry for its type.
 */
export async function runConsumersForEvent(
  event: DomainEventEnvelope
): Promise<RunConsumerResult[]> {
  const consumers = consumerRegistry.getConsumers(event.type);
  const results: RunConsumerResult[] = [];

  for (const consumer of consumers) {
    const result = await runConsumer(consumer, event);
    results.push(result);
  }

  return results;
}
