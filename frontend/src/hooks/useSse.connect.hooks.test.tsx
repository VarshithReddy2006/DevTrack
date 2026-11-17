import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

// Real axios client with a slow fake adapter and real timers: this is the login race between the
// store listener and the effects of every mounted useSse() hook, with a handshake that takes time.
const handshakes = vi.fn();

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  addEventListener = vi.fn();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
}

const openStreams = () => FakeEventSource.instances.filter((es) => es.close.mock.calls.length === 0);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('useSse hooks racing the login flip', () => {
  beforeEach(() => {
    handshakes.mockReset();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  for (const hookCount of [1, 3]) {
    it(`${hookCount} mounted hook(s) and a login flip open one stream, and unmounting closes it`, async () => {
      vi.resetModules();
      const axiosClient = (await import('../utils/axiosClient')).default;
      axiosClient.defaults.adapter = async (config) => {
        handshakes(config.url);
        await wait(50);
        return { data: { data: { ticket: 't' } }, status: 200, statusText: 'OK', headers: {}, config };
      };
      const sse = await import('./useSse');
      const { useUserStore } = await import('../store/userStore');
      const { act, cleanup, render } = await import('@testing-library/react');
      const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

      function Probe() {
        sse.useSse();
        return null;
      }
      const client = new QueryClient();
      useUserStore.setState({ isAuthenticated: false });
      render(
        createElement(
          QueryClientProvider,
          { client },
          ...Array.from({ length: hookCount }, (_, i) => createElement(Probe, { key: i }))
        )
      );
      await act(async () => { await wait(50); });
      expect(handshakes).not.toHaveBeenCalled();

      await act(async () => { useUserStore.setState({ isAuthenticated: true }); });
      await act(async () => { await wait(300); });

      expect(handshakes).toHaveBeenCalledTimes(1);
      expect(FakeEventSource.instances).toHaveLength(1);

      cleanup();
      expect(openStreams()).toHaveLength(0);
    });
  }
});
