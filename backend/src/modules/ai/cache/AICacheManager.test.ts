import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AICacheManager } from './AICacheManager.js';

vi.mock('../../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const put = (key: string, prompt = key, ttl?: number) =>
  AICacheManager.set(key, `response ${key}`, prompt, 'model', 'provider', 'v1', ttl);

describe('AICacheManager', () => {
  beforeEach(() => {
    AICacheManager.clear();
    AICacheManager.setMaxCacheSize(2);
  });

  afterEach(() => {
    vi.useRealTimers();
    AICacheManager.setMaxCacheSize(1000);
  });

  const shared = 'Review this resume and tell me what to improve for a';

  it('keeps prompts that share their first ten words apart', () => {
    expect(AICacheManager.generateSemanticKey(`${shared} backend role`))
      .not.toBe(AICacheManager.generateSemanticKey(`${shared} design role`));

    put('backend', `${shared} backend role`);

    expect(AICacheManager.findSimilar(`${shared} design role`)).toBeNull();
    expect(AICacheManager.findSimilar(`  ${shared.toUpperCase()}   BACKEND role `)?.key).toBe('backend');
  });

  it('evicts the least recently used entry', () => {
    put('first');
    put('second');
    AICacheManager.get('first');

    put('third');

    expect(AICacheManager.getEntry('first')).toBeDefined();
    expect(AICacheManager.getEntry('second')).toBeUndefined();
    expect(AICacheManager.getEntry('third')).toBeDefined();
  });

  it('does not evict another entry when an existing key is overwritten', () => {
    put('first');
    put('second');

    put('second');

    expect(AICacheManager.size()).toBe(2);
    expect(AICacheManager.getEntry('first')).toBeDefined();
  });

  it('does not extend the TTL on a hit', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    put('first', 'first', 1000);

    vi.setSystemTime(new Date('2026-01-01T00:00:00.900Z'));
    expect(AICacheManager.get('first')).not.toBeNull();

    vi.setSystemTime(new Date('2026-01-01T00:00:01.100Z'));
    expect(AICacheManager.get('first')).toBeNull();
  });
});
