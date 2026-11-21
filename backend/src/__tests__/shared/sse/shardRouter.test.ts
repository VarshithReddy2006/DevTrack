// src/__tests__/shared/sse/shardRouter.test.ts
// Unit tests for Shard Router, key formatting, hash-slot tagging, and Stream ID comparison

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TOTAL_SHARDS,
  compareStreamIds,
  getShardForUser,
  getShardStreamKey,
  getStreamGroupForInstance,
  parseStreamId,
} from '../../../shared/sse/shardRouter.js';

describe('Shard Router & Stream Key Addressing', () => {
  describe('getShardForUser', () => {
    it('is strictly deterministic for the same userId', () => {
      const userId = 'user_2xyz987_live';
      const initial = getShardForUser(userId);
      for (let i = 0; i < 50; i++) {
        expect(getShardForUser(userId)).toBe(initial);
      }
    });

    it('returns a shard index in [0, TOTAL_SHARDS - 1]', () => {
      for (let i = 0; i < 200; i++) {
        const id = randomUUID();
        const shard = getShardForUser(id);
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThan(TOTAL_SHARDS);
      }
    });

    it('handles falsy or non-string inputs safely without throwing', () => {
      expect(getShardForUser('')).toBe(0);
      expect(getShardForUser(null as unknown as string)).toBe(0);
      expect(getShardForUser(undefined as unknown as string)).toBe(0);
    });

    it('distributes 10,000 UUIDs evenly across all 16 shards', () => {
      const counts = new Array<number>(TOTAL_SHARDS).fill(0);
      const sampleSize = 10_000;

      for (let i = 0; i < sampleSize; i++) {
        const shard = getShardForUser(randomUUID());
        counts[shard]++;
      }

      // Every single shard must receive at least 4% of traffic (expected = 6.25%)
      const minExpected = sampleSize / TOTAL_SHARDS * 0.6; // 375
      const maxExpected = sampleSize / TOTAL_SHARDS * 1.4; // 875

      for (let s = 0; s < TOTAL_SHARDS; s++) {
        expect(counts[s]).toBeGreaterThan(minExpected);
        expect(counts[s]).toBeLessThan(maxExpected);
      }
    });
  });

  describe('getShardStreamKey', () => {
    it('formats stream keys with Redis cluster hash tags around the shard number', () => {
      expect(getShardStreamKey(0)).toBe('devtrack:sse:stream:{0}');
      expect(getShardStreamKey(7)).toBe('devtrack:sse:stream:{7}');
      expect(getShardStreamKey(15)).toBe('devtrack:sse:stream:{15}');
    });

    it('normalizes out-of-range shard numbers modulo TOTAL_SHARDS', () => {
      expect(getShardStreamKey(16)).toBe('devtrack:sse:stream:{0}');
      expect(getShardStreamKey(17)).toBe('devtrack:sse:stream:{1}');
    });

    it('supports custom prefix when provided', () => {
      expect(getShardStreamKey(3, 'custom:stream')).toBe('custom:stream:{3}');
    });
  });

  describe('getStreamGroupForInstance', () => {
    it('produces pod-specific consumer group names', () => {
      const instanceId = 'e3b0c442-98fc-1c14-9afb-4c7b010c3b91';
      expect(getStreamGroupForInstance(instanceId)).toBe(
        `devtrack:sse:pod:${instanceId}`
      );
    });
  });

  describe('Stream ID parsing & comparison', () => {
    it('parses valid stream IDs into timestamp and sequence components', () => {
      const parsed = parseStreamId('1732185600000-42');
      expect(parsed).toEqual({
        timestampMs: 1732185600000,
        sequence: 42,
      });
    });

    it('returns null for non-stream ID formats', () => {
      expect(parseStreamId('')).toBeNull();
      expect(parseStreamId('invalid-stream-id')).toBeNull();
      expect(parseStreamId('12345')).toBeNull();
      expect(parseStreamId(null)).toBeNull();
    });

    it('correctly compares stream IDs chronologically', () => {
      // Different timestamps
      expect(compareStreamIds('1000-0', '2000-0')).toBeLessThan(0);
      expect(compareStreamIds('2000-0', '1000-0')).toBeGreaterThan(0);

      // Same timestamp, different sequence
      expect(compareStreamIds('1000-1', '1000-2')).toBeLessThan(0);
      expect(compareStreamIds('1000-5', '1000-2')).toBeGreaterThan(0);

      // Identical
      expect(compareStreamIds('1000-3', '1000-3')).toBe(0);

      // Null or invalid fallbacks
      expect(compareStreamIds('invalid', '1000-0')).toBeLessThan(0);
      expect(compareStreamIds('1000-0', 'invalid')).toBeGreaterThan(0);
      expect(compareStreamIds('invalid', 'invalid')).toBe(0);
    });
  });
});
