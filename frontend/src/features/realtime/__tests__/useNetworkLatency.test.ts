import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PING_INTERVAL_MS, useNetworkLatency } from '../../../hooks/useNetworkLatency';

vi.mock('../../../utils/envCheck', () => ({ envConfig: { VITE_API_BASE_URL: 'https://api.devtrack.test/api' } }));

let hidden = false;
const fetchMock = vi.fn();

function setHidden(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Let the pending fetch promise and the state updates after it settle. */
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  let clock = 0;
  // Each ping reads performance.now() twice; 42ms apart.
  vi.spyOn(performance, 'now').mockImplementation(() => { clock += 21; return clock; });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as { hidden?: boolean }).hidden;
});

describe('useNetworkLatency', () => {
  it('sends a HEAD request to the root /health and records the round trip', async () => {
    const { result } = renderHook(() => useNetworkLatency(true));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.devtrack.test/health');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'HEAD', cache: 'no-store' });
    expect(result.current.pingMs).toBe(21);
    expect(result.current.failed).toBe(false);
  });

  it('pings again every 30 seconds', async () => {
    renderHook(() => useNetworkLatency(true));
    await settle();
    await act(async () => { vi.advanceTimersByTime(PING_INTERVAL_MS); });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pauses while the tab is hidden and resumes when it is shown', async () => {
    renderHook(() => useNetworkLatency(true));
    await settle();
    act(() => setHidden(true));
    await act(async () => { vi.advanceTimersByTime(PING_INTERVAL_MS * 3); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => setHidden(false));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not ping again for a quick tab switch', async () => {
    renderHook(() => useNetworkLatency(true));
    await settle();
    act(() => setHidden(true));
    act(() => setHidden(false));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('debounces manual pings', async () => {
    const { result } = renderHook(() => useNetworkLatency(true));
    await settle();
    act(() => result.current.pingNow());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(6_000); });
    act(() => result.current.pingNow());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks network errors and non-2xx answers as failed', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useNetworkLatency(true));
    await settle();
    expect(result.current).toMatchObject({ pingMs: null, failed: true });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await act(async () => { vi.advanceTimersByTime(PING_INTERVAL_MS); });
    await settle();
    expect(result.current.failed).toBe(true);
  });

  it('does nothing while disabled', async () => {
    const { result } = renderHook(() => useNetworkLatency(false));
    await act(async () => { vi.advanceTimersByTime(PING_INTERVAL_MS * 2); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.pingMs).toBeNull();
  });
});
