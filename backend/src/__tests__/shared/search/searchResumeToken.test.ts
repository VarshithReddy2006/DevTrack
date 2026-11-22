// src/__tests__/shared/search/searchResumeToken.test.ts
// Unit tests for the durable Redis-backed Change Stream resume token store.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type Redis from 'ioredis';
import {
  RedisResumeTokenStore,
  getResumeTokenKey,
  RESUME_TOKEN_KEY_PREFIX,
  FencedCheckpointError,
  FENCED_CHECKPOINT_LUA_SCRIPT,
} from '../../../shared/search/searchResumeToken.js';

describe('RedisResumeTokenStore', () => {
  let store: Map<string, string>;
  let mockRedis: Partial<Redis>;
  let tokenStore: RedisResumeTokenStore;

  beforeEach(() => {
    store = new Map<string, string>();

    mockRedis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => {
        const existed = store.delete(key);
        return existed ? 1 : 0;
      }),
      eval: vi.fn(async (_script: string, _numKeys: number, lockKey: string, targetKey: string, ownerToken: string, payload: string) => {
        const currentOwner = store.get(lockKey);
        if (currentOwner === ownerToken) {
          store.set(targetKey, payload);
          return 1;
        }
        return 0;
      }),
    } as unknown as Redis;

    tokenStore = new RedisResumeTokenStore(mockRedis as Redis);
  });

  describe('Key Convention & Formatting', () => {
    it('formats collection keys correctly according to blueprint', () => {
      expect(getResumeTokenKey('dsaproblems')).toBe(`${RESUME_TOKEN_KEY_PREFIX}dsaproblems`);
      expect(getResumeTokenKey('PublicProfiles')).toBe(`${RESUME_TOKEN_KEY_PREFIX}publicprofiles`);
      expect(getResumeTokenKey('  verifiedprojects  ')).toBe(`${RESUME_TOKEN_KEY_PREFIX}verifiedprojects`);
    });

    it('throws when collectionName is empty or whitespace', () => {
      expect(() => getResumeTokenKey('')).toThrow('collectionName cannot be empty');
      expect(() => getResumeTokenKey('   ')).toThrow('collectionName cannot be empty');
    });
  });

  describe('Persistence & Retrieval Operations', () => {
    it('returns null when no resume token has been persisted for a collection', async () => {
      const token = await tokenStore.getResumeToken('dsaproblems');
      expect(token).toBeNull();
    });

    it('persists and retrieves an opaque object token with full fidelity', async () => {
      const opaqueToken = {
        _data: '8265B548000000012B022C0100296E5A1004...sample',
      };

      await tokenStore.saveResumeToken('dsaproblems', opaqueToken);

      const retrieved = await tokenStore.getResumeToken<typeof opaqueToken>('dsaproblems');
      expect(retrieved).not.toBeNull();
      expect(retrieved).toEqual(opaqueToken);
    });

    it('persists and retrieves string-formatted resume tokens', async () => {
      const stringToken = 'resume-token-string-xyz-987';

      await tokenStore.saveResumeToken('publicprofiles', stringToken);

      const retrieved = await tokenStore.getResumeToken<string>('publicprofiles');
      expect(retrieved).toBe(stringToken);
    });

    it('supports repeated checkpoint writes and overwrites existing token idempotently', async () => {
      const tokenV1 = { _data: 'checkpoint-v1' };
      const tokenV2 = { _data: 'checkpoint-v2' };

      await tokenStore.saveResumeToken('verifiedprojects', tokenV1);
      expect(await tokenStore.getResumeToken('verifiedprojects')).toEqual(tokenV1);

      await tokenStore.saveResumeToken('verifiedprojects', tokenV2);
      expect(await tokenStore.getResumeToken('verifiedprojects')).toEqual(tokenV2);
    });

    it('clears persisted resume token checkpoint when requested', async () => {
      const token = { _data: 'token-to-delete' };
      await tokenStore.saveResumeToken('dsaproblems', token);
      expect(await tokenStore.getResumeToken('dsaproblems')).not.toBeNull();

      await tokenStore.clearResumeToken('dsaproblems');
      expect(await tokenStore.getResumeToken('dsaproblems')).toBeNull();
    });

    it('isolates checkpoints across different collections', async () => {
      const dsaToken = { _data: 'dsa-checkpoint' };
      const profileToken = { _data: 'profile-checkpoint' };

      await tokenStore.saveResumeToken('dsaproblems', dsaToken);
      await tokenStore.saveResumeToken('publicprofiles', profileToken);

      expect(await tokenStore.getResumeToken('dsaproblems')).toEqual(dsaToken);
      expect(await tokenStore.getResumeToken('publicprofiles')).toEqual(profileToken);
      expect(await tokenStore.getResumeToken('verifiedprojects')).toBeNull();
    });

    it('does not mutate or alter the original token reference', async () => {
      const originalToken = Object.freeze({ _data: 'immutable-token-test', seq: 42 });
      await expect(tokenStore.saveResumeToken('dsaproblems', originalToken)).resolves.not.toThrow();
      expect(await tokenStore.getResumeToken('dsaproblems')).toEqual(originalToken);
    });
  });

  describe('Validation & Malformed Value Handling', () => {
    it('throws when attempting to save null or undefined token', async () => {
      await expect(tokenStore.saveResumeToken('dsaproblems', null)).rejects.toThrow('Cannot persist undefined or null resume token');
      await expect(tokenStore.saveResumeToken('dsaproblems', undefined)).rejects.toThrow('Cannot persist undefined or null resume token');
    });

    it('handles malformed JSON in Redis gracefully by returning null', async () => {
      store.set(getResumeTokenKey('dsaproblems'), 'invalid-non-json-{{{');

      const token = await tokenStore.getResumeToken('dsaproblems');
      expect(token).toBeNull();
    });

    it('handles non-object parsed JSON in Redis gracefully by returning null', async () => {
      store.set(getResumeTokenKey('dsaproblems'), JSON.stringify(12345));

      const token = await tokenStore.getResumeToken('dsaproblems');
      expect(token).toBeNull();
    });

    it('handles payload missing token property gracefully by returning null', async () => {
      store.set(getResumeTokenKey('dsaproblems'), JSON.stringify({ collection: 'dsaproblems', updatedAt: 12345 }));

      const token = await tokenStore.getResumeToken('dsaproblems');
      expect(token).toBeNull();
    });
  });

  describe('Redis Failure Resilience', () => {
    it('propagates Redis read failures so caller is aware', async () => {
      (mockRedis.get as any).mockRejectedValueOnce(new Error('Redis connection timed out'));

      await expect(tokenStore.getResumeToken('dsaproblems')).rejects.toThrow('Redis connection timed out');
    });

    it('propagates Redis write failures so caller does not assume checkpoint succeeded', async () => {
      (mockRedis.set as any).mockRejectedValueOnce(new Error('Redis READONLY replica'));

      await expect(
        tokenStore.saveResumeToken('dsaproblems', { _data: 'test' })
      ).rejects.toThrow('Redis READONLY replica');
    });

    it('propagates Redis deletion failures', async () => {
      (mockRedis.del as any).mockRejectedValueOnce(new Error('Redis network partition'));

      await expect(tokenStore.clearResumeToken('dsaproblems')).rejects.toThrow('Redis network partition');
    });
  });

  describe('Checkpoint Fencing (SEC-02)', () => {
    const lockKey = 'devtrack:search:leader:lock';
    const ownerToken = 'worker-uuid-1234';

    it('successfully saves checkpoint when caller owns the leader lease', async () => {
      store.set(lockKey, ownerToken);

      const token = { _data: 'fenced-checkpoint-token' };
      await tokenStore.saveResumeToken('dsaproblems', token, { lockKey, ownerToken });

      const retrieved = await tokenStore.getResumeToken('dsaproblems');
      expect(retrieved).toEqual(token);
      expect(mockRedis.eval).toHaveBeenCalledWith(
        FENCED_CHECKPOINT_LUA_SCRIPT,
        2,
        lockKey,
        getResumeTokenKey('dsaproblems'),
        ownerToken,
        expect.stringContaining('fenced-checkpoint-token')
      );
    });

    it('throws FencedCheckpointError when lease is expired / held by no one', async () => {
      // lockKey not set in Redis store
      const token = { _data: 'stale-checkpoint-token' };

      await expect(
        tokenStore.saveResumeToken('dsaproblems', token, { lockKey, ownerToken })
      ).rejects.toThrow(FencedCheckpointError);

      const retrieved = await tokenStore.getResumeToken('dsaproblems');
      expect(retrieved).toBeNull();
    });

    it('throws FencedCheckpointError when lease is held by another worker', async () => {
      store.set(lockKey, 'successor-worker-5678');

      const token = { _data: 'stale-predecessor-token' };

      await expect(
        tokenStore.saveResumeToken('dsaproblems', token, { lockKey, ownerToken })
      ).rejects.toThrow(FencedCheckpointError);

      // Verify resume token in Redis was NOT overwritten
      const retrieved = await tokenStore.getResumeToken('dsaproblems');
      expect(retrieved).toBeNull();
    });

    it('includes lockKey and ownerToken on FencedCheckpointError instance', async () => {
      store.set(lockKey, 'other-worker');

      try {
        await tokenStore.saveResumeToken('dsaproblems', { _data: 'err-test' }, { lockKey, ownerToken });
        expect.unreachable('Should have thrown FencedCheckpointError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(FencedCheckpointError);
        expect(err.lockKey).toBe(lockKey);
        expect(err.ownerToken).toBe(ownerToken);
        expect(err.name).toBe('FencedCheckpointError');
      }
    });
  });
});
