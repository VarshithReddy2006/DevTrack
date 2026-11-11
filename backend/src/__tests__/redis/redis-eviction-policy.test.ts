import { expect, it, vi } from 'vitest';
import { checkRedisEvictionPolicy } from '../../shared/redis/client.js';
import { logger } from '../../shared/logger.js';

vi.mock('../../shared/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

it('accepts noeviction without logging a warning', async () => {
  const config = vi.fn().mockResolvedValue(['maxmemory-policy', 'noeviction']);
  await checkRedisEvictionPolicy({ config });
  expect(config).toHaveBeenCalledExactlyOnceWith('GET', 'maxmemory-policy');
  expect(logger.warn).not.toHaveBeenCalled();
});

it('warns when Redis is configured to evict queue keys', async () => {
  const config = vi.fn().mockResolvedValue(['maxmemory-policy', 'allkeys-lru']);
  await checkRedisEvictionPolicy({ config });
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('requires maxmemory-policy=noeviction'), { policy: 'allkeys-lru' });
});

it('handles managed Redis that denies CONFIG without failing startup', async () => {
  const config = vi.fn().mockRejectedValue(new Error('NOPERM'));
  await expect(checkRedisEvictionPolicy({ config })).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('CONFIG GET unavailable'));
});
