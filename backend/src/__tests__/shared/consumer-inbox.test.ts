// backend/src/__tests__/shared/consumer-inbox.test.ts
// Unit and integration tests for ProcessedEvent inbox deduplication, consumer runner, and SSE bridge.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { ProcessedEvent } from '../../db/models/processedEvent.model.js';
import { createDomainEvent } from '../../shared/events/eventContract.js';
import {
  ConsumerRegistry,
  consumerRegistry,
  registerConsumer,
  getConsumersForEvent,
  clearConsumerRegistry,
  type ConsumerDefinition,
} from '../../shared/events/consumerRegistry.js';
import { runConsumer, runConsumersForEvent, executeInboxNonTransactional } from '../../shared/events/runConsumer.js';
import {
  SSE_BRIDGE_ALLOWLIST,
  isEventAllowlisted,
  mapDomainEventToSseType,
  forwardDomainEventToSse,
  sseBridgeConsumer,
  registerSseBridgeConsumers,
} from '../../shared/events/sseBridge.js';
import { eventBus } from '../../shared/sse/eventBus.js';

describe('ProcessedEvent Inbox Deduplication & Consumer Runner', () => {
  beforeEach(async () => {
    await ProcessedEvent.init();
    await ProcessedEvent.deleteMany({});
    clearConsumerRegistry();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    clearConsumerRegistry();
  });

  describe('Model Indexes & Schema Constraints', () => {
    it('enforces compound uniqueness on { consumer, eventId }', async () => {
      const eventId = 'evt-unique-001';
      const consumer = 'xp-consumer';

      await ProcessedEvent.create({
        consumer,
        eventId,
        eventType: 'xp.awarded',
        processedAt: new Date(),
      });

      // Inserting duplicate must fail with code 11000
      await expect(
        ProcessedEvent.create({
          consumer,
          eventId,
          eventType: 'xp.awarded',
          processedAt: new Date(),
        })
      ).rejects.toThrow();
    });

    it('allows different consumers to process the same eventId', async () => {
      const eventId = 'evt-shared-002';

      const entry1 = await ProcessedEvent.create({
        consumer: 'xp-consumer',
        eventId,
        eventType: 'focus.session.completed',
        processedAt: new Date(),
      });

      const entry2 = await ProcessedEvent.create({
        consumer: 'streak-consumer',
        eventId,
        eventType: 'focus.session.completed',
        processedAt: new Date(),
      });

      expect(entry1._id).toBeDefined();
      expect(entry2._id).toBeDefined();
      expect(await ProcessedEvent.countDocuments({ eventId })).toBe(2);
    });

    it('checkAndMark static helper provides atomic idempotency check', async () => {
      const eventId = 'evt-checkmark-003';
      const eventType = 'sync.completed';
      const userId = new Types.ObjectId().toString();

      const first = await (ProcessedEvent as any).checkAndMark(
        eventId,
        eventType,
        userId,
        7,
        'sync-worker'
      );
      expect(first.alreadyProcessed).toBe(false);

      const second = await (ProcessedEvent as any).checkAndMark(
        eventId,
        eventType,
        userId,
        7,
        'sync-worker'
      );
      expect(second.alreadyProcessed).toBe(true);
      expect(second.existingEvent).toBeDefined();
    });
  });

  describe('runConsumer execution protocol', () => {
    it('executes inbox consumer once on first delivery and skips on replay', async () => {
      let executionCount = 0;
      const consumer: ConsumerDefinition = {
        name: 'test-mission-inbox',
        pool: 'missions',
        dedup: 'inbox',
        handle: async () => {
          executionCount++;
        },
      };

      const event = createDomainEvent('focus.session.completed', { minutes: 25 }, {
        userId: new Types.ObjectId().toString(),
      });

      // First run: executes
      const firstResult = await runConsumer(consumer, event);
      expect(firstResult.executed).toBe(true);
      expect(firstResult.skipped).toBe(false);
      expect(firstResult.reason).toBe('executed');
      expect(executionCount).toBe(1);

      // Verify ProcessedEvent was stored
      const record = await ProcessedEvent.findOne({ consumer: consumer.name, eventId: event.id });
      expect(record).not.toBeNull();
      expect(record?.consumer).toBe('test-mission-inbox');

      // Second run (duplicate/retry): skipped cleanly
      const secondResult = await runConsumer(consumer, event);
      expect(secondResult.executed).toBe(false);
      expect(secondResult.skipped).toBe(true);
      expect(secondResult.reason).toBe('duplicate_inbox');
      expect(executionCount).toBe(1); // handler NOT re-executed
    });

    it('executes exactly once under high concurrency with identical event delivery', async () => {
      let executionCount = 0;
      const consumer: ConsumerDefinition = {
        name: 'concurrent-inbox-worker',
        pool: 'activity',
        dedup: 'inbox',
        handle: async () => {
          executionCount++;
        },
      };

      const event = createDomainEvent('dsa.problem.solved', { problemId: 'two-sum' }, {
        userId: new Types.ObjectId().toString(),
      });

      // Dispatch 8 simultaneous runs of the exact same event to the same consumer
      const results = await Promise.all(
        Array.from({ length: 8 }, () => runConsumer(consumer, event))
      );

      const executedCount = results.filter(r => r.executed).length;
      const skippedCount = results.filter(r => r.skipped).length;

      expect(executedCount).toBe(1);
      expect(skippedCount).toBe(7);
      expect(executionCount).toBe(1);
    });

    it('rolls back ProcessedEvent if consumer handler throws an error in transaction', async () => {
      let attempt = 0;
      const consumer: ConsumerDefinition = {
        name: 'failing-consumer',
        pool: 'test',
        dedup: 'inbox',
        handle: async () => {
          attempt++;
          if (attempt === 1) {
            throw new Error('Database connection reset during consumer run');
          }
        },
      };

      const event = createDomainEvent('xp.awarded', { amount: 50 }, {
        userId: new Types.ObjectId().toString(),
      });

      // First attempt fails
      await expect(runConsumer(consumer, event)).rejects.toThrow('Database connection reset');

      // Transaction rollback means ProcessedEvent must NOT exist
      const recordAfterRollback = await ProcessedEvent.findOne({
        consumer: consumer.name,
        eventId: event.id,
      });
      expect(recordAfterRollback).toBeNull();

      // Retry attempt succeeds
      const retryResult = await runConsumer(consumer, event);
      expect(retryResult.executed).toBe(true);
      expect(retryResult.skipped).toBe(false);
      expect(attempt).toBe(2);

      const recordAfterRetry = await ProcessedEvent.findOne({
        consumer: consumer.name,
        eventId: event.id,
      });
      expect(recordAfterRetry).not.toBeNull();
    });

    it('removes ProcessedEvent on handler failure in executeInboxNonTransactional so retries can execute', async () => {
      let attempts = 0;
      const consumer: ConsumerDefinition = {
        name: 'standalone-failing-consumer',
        pool: 'test',
        dedup: 'inbox',
        handle: async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('Downstream network timeout in standalone mode');
          }
        },
      };

      const event = createDomainEvent('xp.awarded', { amount: 75 }, {
        userId: new Types.ObjectId().toString(),
      });

      // First run: handler throws
      await expect(executeInboxNonTransactional(consumer, event)).rejects.toThrow(
        'Downstream network timeout in standalone mode'
      );
      expect(attempts).toBe(1);

      // Verify ProcessedEvent was deleted on failure
      const recordAfterFailure = await ProcessedEvent.findOne({
        consumer: consumer.name,
        eventId: event.id,
      });
      expect(recordAfterFailure).toBeNull();

      // Retry: must execute successfully rather than being skipped as duplicate_inbox
      const retryResult = await executeInboxNonTransactional(consumer, event);
      expect(retryResult.executed).toBe(true);
      expect(retryResult.skipped).toBe(false);
      expect(retryResult.reason).toBe('executed');
      expect(attempts).toBe(2);

      // Verify ProcessedEvent now exists after successful retry
      const recordAfterSuccess = await ProcessedEvent.findOne({
        consumer: consumer.name,
        eventId: event.id,
      });
      expect(recordAfterSuccess).not.toBeNull();
      expect(recordAfterSuccess?.result?.success).toBe(true);
    });

    it('falls back to executeInboxNonTransactional and cleans up ProcessedEvent on failure when sessions are unavailable', async () => {
      let attempts = 0;
      const consumer: ConsumerDefinition = {
        name: 'sessionless-failing-consumer',
        pool: 'test',
        dedup: 'inbox',
        handle: async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('Service unavailable during consumer run');
          }
        },
      };

      const event = createDomainEvent('focus.session.completed', { minutes: 45 }, {
        userId: new Types.ObjectId().toString(),
      });

      // Mock startSession to reject, forcing fallback to non-transactional path
      const startSessionSpy = vi.spyOn(mongoose, 'startSession').mockRejectedValueOnce(
        new Error('This MongoDB deployment does not support transactions')
      );

      await expect(runConsumer(consumer, event)).rejects.toThrow('Service unavailable during consumer run');
      expect(attempts).toBe(1);

      // Record should be cleaned up
      const recordAfterFail = await ProcessedEvent.findOne({
        consumer: consumer.name,
        eventId: event.id,
      });
      expect(recordAfterFail).toBeNull();

      // Mock startSession to reject again on retry
      startSessionSpy.mockRejectedValueOnce(
        new Error('This MongoDB deployment does not support transactions')
      );

      const retryResult = await runConsumer(consumer, event);
      expect(retryResult.executed).toBe(true);
      expect(retryResult.skipped).toBe(false);
      expect(attempts).toBe(2);

      startSessionSpy.mockRestore();
    });

    it('executes natural dedup consumers directly without ProcessedEvent records', async () => {
      let executed = false;
      const consumer: ConsumerDefinition = {
        name: 'xp-natural-consumer',
        pool: 'xp',
        dedup: 'natural',
        handle: async () => {
          executed = true;
        },
      };

      const event = createDomainEvent('xp.awarded', { amount: 100 }, {
        userId: new Types.ObjectId().toString(),
      });

      const result = await runConsumer(consumer, event);
      expect(result.executed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(executed).toBe(true);

      // Verify no ProcessedEvent was written
      const record = await ProcessedEvent.findOne({ consumer: consumer.name, eventId: event.id });
      expect(record).toBeNull();
    });
  });

  describe('ConsumerRegistry', () => {
    it('registers and retrieves consumers by event type', () => {
      const reg = new ConsumerRegistry();
      const consumerA: ConsumerDefinition = {
        name: 'consumerA',
        dedup: 'inbox',
        handle: async () => {},
      };
      const consumerB: ConsumerDefinition = {
        name: 'consumerB',
        dedup: 'natural',
        handle: async () => {},
      };

      reg.register('focus.session.completed', consumerA);
      reg.register('focus.session.completed', consumerB);

      const consumers = reg.getConsumers('focus.session.completed');
      expect(consumers).toHaveLength(2);
      expect(consumers.map(c => c.name)).toEqual(['consumerA', 'consumerB']);
    });

    it('unregisters consumers and clears registry', () => {
      const reg = new ConsumerRegistry();
      const consumer: ConsumerDefinition = {
        name: 'testConsumer',
        dedup: 'inbox',
        handle: async () => {},
      };

      reg.register('sync.completed', consumer);
      expect(reg.getConsumers('sync.completed')).toHaveLength(1);

      reg.unregister('sync.completed', 'testConsumer');
      expect(reg.getConsumers('sync.completed')).toHaveLength(0);
    });

    it('runConsumersForEvent dispatches to all registered consumers', async () => {
      const calls: string[] = [];
      registerConsumer('revision.reviewed', {
        name: 'xp-awarder',
        dedup: 'inbox',
        handle: async () => {
          calls.push('xp-awarder');
        },
      });
      registerConsumer('revision.reviewed', {
        name: 'readiness-updater',
        dedup: 'inbox',
        handle: async () => {
          calls.push('readiness-updater');
        },
      });

      const event = createDomainEvent('revision.reviewed', { cardId: 'c1' }, {
        userId: new Types.ObjectId().toString(),
      });

      const results = await runConsumersForEvent(event);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.executed)).toBe(true);
      expect(calls).toEqual(['xp-awarder', 'readiness-updater']);
    });
  });

  describe('SSE Bridge Consumer', () => {
    it('identifies allowlisted domain events correctly', () => {
      expect(isEventAllowlisted('sync.started')).toBe(true);
      expect(isEventAllowlisted('focus.session.completed')).toBe(true);
      expect(isEventAllowlisted('contest.starting-soon')).toBe(true);
      expect(isEventAllowlisted('unknown.random.event')).toBe(false);
    });

    it('maps domain event types to SSE format', () => {
      expect(mapDomainEventToSseType('sync.started')).toBe('sync_started');
      expect(mapDomainEventToSseType('sync.completed')).toBe('sync_completed');
      expect(mapDomainEventToSseType('xp.awarded')).toBe('xp_updated');
      expect(mapDomainEventToSseType('xp.level_up')).toBe('level_up');
      expect(mapDomainEventToSseType('focus.session.completed')).toBe('focus_session_completed');
      expect(mapDomainEventToSseType('contest.starting-soon')).toBe('contest_starting_soon');
      expect(mapDomainEventToSseType('dsa.problem.solved')).toBe('dsa_problem_solved');
    });

    it('forwards allowlisted events via eventBus.publishEnvelope with metadata', async () => {
      const publishSpy = vi.spyOn(eventBus, 'publishEnvelope').mockResolvedValue(undefined as any);

      const userId = new Types.ObjectId().toString();
      const event = createDomainEvent(
        'focus.session.completed',
        { sessionId: 's123', minutes: 25 },
        {
          userId,
          correlationId: 'corr-xyz-789',
          schemaVersion: 2,
        }
      );

      const forwarded = await forwardDomainEventToSse(event);
      expect(forwarded).toBe(true);

      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(publishSpy).toHaveBeenCalledWith(
        userId,
        'focus_session_completed',
        { sessionId: 's123', minutes: 25 },
        'corr-xyz-789',
        2
      );
    });

    it('skips non-allowlisted events without forwarding to SSE', async () => {
      const publishSpy = vi.spyOn(eventBus, 'publishEnvelope').mockResolvedValue(undefined as any);

      const event = createDomainEvent(
        'auth.token_refreshed' as any,
        { refreshed: true },
        { userId: new Types.ObjectId().toString() }
      );

      const forwarded = await forwardDomainEventToSse(event);
      expect(forwarded).toBe(false);
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('skips events with empty userId', async () => {
      const publishSpy = vi.spyOn(eventBus, 'publishEnvelope').mockResolvedValue(undefined as any);

      const event = createDomainEvent(
        'sync.completed',
        { platform: 'leetcode' },
        { userId: '' }
      );

      const forwarded = await forwardDomainEventToSse(event);
      expect(forwarded).toBe(false);
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('registers sseBridgeConsumer across all allowlisted events', () => {
      registerSseBridgeConsumers();
      for (const eventType of SSE_BRIDGE_ALLOWLIST) {
        const consumers = getConsumersForEvent(eventType);
        expect(consumers.some(c => c.name === 'sseBridgeConsumer')).toBe(true);
      }
    });
  });
});
