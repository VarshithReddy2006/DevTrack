import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

// Real timers: the connect path lazily imports axios, which needs real time to resolve.
const post = vi.fn();
const get = vi.fn();
vi.mock('../utils/axiosClient', () => ({ default: { post, get } }));
vi.mock('../services/dailyChallengeService', () => ({
  getTodayChallenge: vi.fn().mockResolvedValue({ data: { success: true, data: { challenge: null, userCompleted: false } } }),
}));

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

const envelope = (id: string, type: string) =>
  ({
    data: JSON.stringify({
      id,
      type,
      sequence: 1,
      timestamp: new Date().toISOString(),
      userId: 'u1',
      payload: { n: id },
    }),
    lastEventId: id,
  }) as unknown as MessageEvent;

type Case = {
  name: string;
  load: () => Promise<() => unknown>;
  key: string[];
  own: string[];
};

const cases: Case[] = [
  { name: 'useXp', load: async () => (await import('./useXp')).useXp, key: ['xp', 'state'], own: ['xp_updated', 'level_up'] },
  {
    name: 'useRuntimeState',
    load: async () => (await import('./useRuntimeState')).useRuntimeState,
    key: ['runtime-state'],
    own: ['runtime_state_patch', 'runtime_state_full', 'xp_updated', 'level_up'],
  },
  {
    name: 'useDailyChallenge',
    load: async () => (await import('./useDailyChallenge')).useDailyChallenge,
    key: ['dailyChallenge', 'today'],
    own: ['challenge_completed'],
  },
];

describe('hooks that pass extraInvalidateKeys to useSse', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { data: { ticket: 't' } } });
    get.mockReset();
    get.mockResolvedValue({ data: { success: true, data: {} } });
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    localStorage.setItem('devtrack_access_token', 'jwt');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  for (const c of cases) {
    it(`${c.name} only invalidates ${c.key.join('/')} for its own event types`, async () => {
      vi.resetModules();
      const useHook = await c.load();
      const { useUserStore } = await import('../store/userStore');
      const { act, renderHook } = await import('@testing-library/react');
      const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
      useUserStore.setState({ isAuthenticated: true });

      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const spy = vi.spyOn(client, 'invalidateQueries');
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        createElement(QueryClientProvider, { client }, children);
      const { unmount } = renderHook(() => useHook(), { wrapper });

      await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
      const es = FakeEventSource.instances[0];
      await act(async () => { es.onopen!(); });
      spy.mockClear();

      // events that belong to somebody else, like notifications or interview token streaming
      await act(async () => {
        es.onmessage!(envelope('u-1', 'notification_created'));
        es.onmessage!(envelope('u-2', 'interview.turn.delta'));
        es.onmessage!(envelope('u-3', 'sync_started'));
      });
      expect(spy.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === JSON.stringify(c.key))).toHaveLength(0);

      for (const [i, type] of c.own.entries()) {
        spy.mockClear();
        await act(async () => { es.onmessage!(envelope(`o-${i}`, type)); });
        const hits = spy.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === JSON.stringify(c.key));
        expect(hits.length, `${c.name} should still invalidate on ${type}`).toBeGreaterThan(0);
      }
      unmount();
    });
  }
});
