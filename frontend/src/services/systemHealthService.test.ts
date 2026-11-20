import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkApiReady } from './systemHealthService';

vi.mock('../utils/envCheck', () => ({ envConfig: { VITE_API_BASE_URL: 'https://api.devtrack.test/api' } }));

afterEach(() => vi.unstubAllGlobals());

describe('checkApiReady', () => {
  it('asks the root readiness probe, not the /api path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(checkApiReady()).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.devtrack.test/health/ready');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
  });

  it('reports not ready on 503 or a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    await expect(checkApiReady()).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(checkApiReady()).resolves.toBe(false);
  });
});
