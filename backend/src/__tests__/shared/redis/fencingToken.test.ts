// src/__tests__/shared/redis/fencingToken.test.ts
// Unit and integration tests for monotonic fencing tokens and storage-layer stateVersion guards.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { UnifiedRuntimeState } from '../../../db/models/index.js';
import { UnifiedRuntimeStateService } from '../../../modules/runtime-state/unifiedRuntimeState.service.js';
import {
  StaleFencingTokenError,
  fenceStamp,
  fencedFilter,
  isDuplicateKeyError,
} from '../../../shared/redis/fencingToken.js';

vi.mock('../../../shared/sse/index.js', () => ({
  eventBus: { emitRuntimeStatePatch: vi.fn() },
}));

describe('Fencing Token Helpers & UnifiedRuntimeState Storage Guards', () => {
  const services: UnifiedRuntimeStateService[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const service of services.splice(0)) {
      await service.flushPendingEvents().catch(() => {});
    }
    vi.restoreAllMocks();
  });

  it('fencedFilter returns original filter when token is null or undefined', () => {
    const base = { userId: 'u1' };
    expect(fencedFilter(base, null)).toEqual(base);
    expect(fencedFilter(base, undefined)).toEqual(base);
    expect(fenceStamp(null)).toEqual({});
    expect(fenceStamp(42)).toEqual({ stateVersion: 42 });
  });

  it('fencedFilter wraps filter with strict < token condition plus unset/null allowance', () => {
    const wrapped = fencedFilter({ _id: 'abc' }, 1042, 'stateVersion');
    expect(wrapped).toEqual({
      $and: [
        { _id: 'abc' },
        {
          $or: [
            { stateVersion: { $lt: 1042 } },
            { stateVersion: { $exists: false } },
            { stateVersion: null },
          ],
        },
      ],
    });
  });

  it('isDuplicateKeyError identifies Mongo E11000 collisions', () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isDuplicateKeyError(new Error('E11000 duplicate key error collection'))).toBe(true);
    expect(isDuplicateKeyError(new Error('network timeout'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });

  it('rejects stale worker writes against UnifiedRuntimeState when a newer fencing token has committed', async () => {
    const userId = new Types.ObjectId().toHexString();
    await UnifiedRuntimeState.create({
      userId,
      xp: 100,
      stateVersion: 10,
      lastCalculatedAt: new Date(),
    });

    const service = new UnifiedRuntimeStateService(10);
    services.push(service);

    // Worker 2 with higher token 11 advances stateVersion from 10 -> 11
    const fresher = await service.updateFromEvent({
      userId,
      eventId: 'evt-worker-2',
      eventType: 'xp_awarded',
      timestamp: new Date(),
      data: { xpAwarded: 25 },
      fenceToken: 11,
    });
    expect(fresher.xp).toBe(125);
    expect(fresher.stateVersion).toBe(11);

    // Stale Worker 1 wakes up from GC pause with expired token 9 and must be rejected
    await expect(
      service.updateFromEvent({
        userId,
        eventId: 'evt-worker-1-stale',
        eventType: 'xp_awarded',
        timestamp: new Date(),
        data: { xpAwarded: 500 },
        fenceToken: 9,
      })
    ).rejects.toBeInstanceOf(StaleFencingTokenError);

    // Storage still reflects Worker 2's state untouched
    const persisted = await UnifiedRuntimeState.findOne({ userId }).lean();
    expect(persisted?.xp).toBe(125);
    expect(persisted?.stateVersion).toBe(11);

    // Consume buffered drainError before afterEach
    await expect(service.flushPendingEvents()).rejects.toBeInstanceOf(StaleFencingTokenError);
  });

  it('rejects stale direct rebuildRuntimeState calls when existing stateVersion >= fenceToken', async () => {
    const userId = new Types.ObjectId().toHexString();
    await UnifiedRuntimeState.create({
      userId,
      xp: 250,
      stateVersion: 20,
      lastCalculatedAt: new Date(),
    });

    const service = new UnifiedRuntimeStateService(10);
    services.push(service);

    await expect(
      service.rebuildRuntimeState(userId, { fromEventId: 'stale-rebuild', fenceToken: 15 })
    ).rejects.toBeInstanceOf(StaleFencingTokenError);

    // Equal fence token must also be rejected (strictly monotonic)
    await expect(
      service.rebuildRuntimeState(userId, { fromEventId: 'replay-rebuild', fenceToken: 20 })
    ).rejects.toBeInstanceOf(StaleFencingTokenError);

    const updated = await service.rebuildRuntimeState(userId, {
      fromEventId: 'newer-rebuild',
      fenceToken: 21,
    });
    expect(updated.stateVersion).toBe(21);
  });
});
