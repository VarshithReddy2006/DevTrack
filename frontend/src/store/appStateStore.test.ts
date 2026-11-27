import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('appStateStore overlay timers and notification hydration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels pending transition timer on clearQueue so subsequent enqueue is unaffected', async () => {
    const { useAppStateStore } = await import('./appStateStore');
    const store = useAppStateStore.getState();

    store.enqueue('level_up', { level: 2 }, 4000);
    store.enqueue('streak_milestone', { days: 7 }, 4000);
    expect(useAppStateStore.getState().activeOverlay?.type).toBe('level_up');
    expect(useAppStateStore.getState().queue).toHaveLength(1);

    store.dismiss();
    expect(useAppStateStore.getState().activeOverlay).toBeNull();

    // Clear during the 300ms transition window and immediately enqueue a new overlay
    vi.advanceTimersByTime(100);
    store.clearQueue();
    store.enqueue('achievement_unlocked', { id: 'first' }, 5000);

    const afterEnqueue = useAppStateStore.getState().activeOverlay;
    expect(afterEnqueue?.type).toBe('achievement_unlocked');
    expect(useAppStateStore.getState().queue).toHaveLength(0);

    // Passing the old 300ms boundary must not disturb the new overlay
    vi.advanceTimersByTime(250);
    expect(useAppStateStore.getState().activeOverlay?.id).toBe(afterEnqueue?.id);
  });

  it('cancels pending auto-dismiss timer on clearQueue so a new overlay is not prematurely dismissed', async () => {
    const { useAppStateStore } = await import('./appStateStore');
    const store = useAppStateStore.getState();

    store.enqueue('level_up', { level: 3 }, 1000);
    const firstId = useAppStateStore.getState().activeOverlay?.id;
    expect(firstId).toBeDefined();

    vi.advanceTimersByTime(500);
    store.clearQueue();
    store.enqueue('streak_at_risk', { days: 10 }, 5000);

    const secondId = useAppStateStore.getState().activeOverlay?.id;
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);

    // Advancing past the first overlay's 1000ms auto-dismiss must keep the second overlay active
    vi.advanceTimersByTime(600);
    expect(useAppStateStore.getState().activeOverlay?.id).toBe(secondId);

    // Second overlay auto-dismisses at its own 5000ms duration
    vi.advanceTimersByTime(4400);
    expect(useAppStateStore.getState().activeOverlay).toBeNull();
  });

  it('cancels stale dismiss transition timer when enqueue activates a new overlay within 300ms', async () => {
    const { useAppStateStore } = await import('./appStateStore');
    const store = useAppStateStore.getState();

    store.enqueue('level_up', { level: 4 }, 4000);
    store.dismiss();
    expect(useAppStateStore.getState().activeOverlay).toBeNull();

    vi.advanceTimersByTime(100);
    store.enqueue('streak_milestone', { days: 14 }, 2000);
    const activeAfterEnqueue = useAppStateStore.getState().activeOverlay;
    expect(activeAfterEnqueue?.type).toBe('streak_milestone');

    // Enqueue a higher-priority item while streak_milestone is active
    store.enqueue('streak_at_risk', { days: 14 }, 2000);
    expect(useAppStateStore.getState().activeOverlay?.id).toBe(activeAfterEnqueue?.id);
    expect(useAppStateStore.getState().queue.map((item) => item.type)).toEqual(['streak_at_risk']);

    // At 300ms from original dismiss, stale timer must not fire; streak_milestone stays active until 2000ms
    vi.advanceTimersByTime(250);
    expect(useAppStateStore.getState().activeOverlay?.id).toBe(activeAfterEnqueue?.id);

    // After streak_milestone auto-dismisses (at +2000ms) and transitions (+300ms), streak_at_risk activates
    vi.advanceTimersByTime(1750);
    expect(useAppStateStore.getState().activeOverlay).toBeNull();
    vi.advanceTimersByTime(300);
    expect(useAppStateStore.getState().activeOverlay?.type).toBe('streak_at_risk');
  });

  it('deduplicates rapid dismiss calls and advances priority-ordered queue cleanly', async () => {
    const { useAppStateStore } = await import('./appStateStore');
    const store = useAppStateStore.getState();

    store.enqueue('level_up', { level: 5 }, 4000);
    store.enqueue('achievement_unlocked', { badge: 'a' }, 4000);
    store.enqueue('streak_at_risk', { days: 5 }, 4000);

    expect(useAppStateStore.getState().activeOverlay?.type).toBe('level_up');
    expect(useAppStateStore.getState().queue.map((q) => q.type)).toEqual([
      'streak_at_risk',
      'achievement_unlocked',
    ]);

    store.dismiss();
    vi.advanceTimersByTime(100);
    store.dismiss();

    // Still waiting for the latest 300ms transition
    vi.advanceTimersByTime(250);
    expect(useAppStateStore.getState().activeOverlay).toBeNull();

    // At 300ms from second dismiss, only the highest-priority queued overlay activates
    vi.advanceTimersByTime(50);
    expect(useAppStateStore.getState().activeOverlay?.type).toBe('streak_at_risk');
    expect(useAppStateStore.getState().queue.map((q) => q.type)).toEqual(['achievement_unlocked']);
  });

  it('preserves pre-hydration notifications on login hydration and clears cleanly on logout/switch', async () => {
    localStorage.setItem(
      'devtrack_notifications:user-a',
      JSON.stringify([
        {
          id: 'stored-a',
          type: 'sync_completed',
          title: 'Stored A',
          priority: 'low',
          read: false,
          createdAt: 1000,
        },
      ]),
    );
    localStorage.setItem(
      'devtrack_notifications:user-b',
      JSON.stringify([
        {
          id: 'stored-b',
          type: 'sync_completed',
          title: 'Stored B',
          priority: 'low',
          read: true,
          createdAt: 2000,
        },
      ]),
    );

    const { useAppStateStore, setNotificationAccount } = await import('./appStateStore');

    // Push notifications before account hydration
    useAppStateStore.getState().addNotification({
      type: 'level_up',
      title: 'Pre-hydration notification',
      priority: 'high',
    });
    expect(useAppStateStore.getState().notifications).toHaveLength(1);

    // Hydrate user-a: pre-hydration notification should be preserved alongside user-a's stored items
    setNotificationAccount('user-a');
    const afterHydration = useAppStateStore.getState();
    expect(afterHydration.notifications.map((n) => n.title)).toEqual([
      'Pre-hydration notification',
      'Stored A',
    ]);
    expect(afterHydration.unreadCount).toBe(2);
    expect(JSON.parse(localStorage.getItem('devtrack_notifications:user-a')!).map((n: { title: string }) => n.title))
      .toEqual(['Pre-hydration notification', 'Stored A']);

    // Switching directly to user-b must isolate user-b's notifications without leaking user-a's
    setNotificationAccount('user-b');
    expect(useAppStateStore.getState().notifications.map((n) => n.id)).toEqual(['stored-b']);
    expect(useAppStateStore.getState().unreadCount).toBe(0);

    // Logout clears in-memory notifications cleanly
    setNotificationAccount(null);
    expect(useAppStateStore.getState().notifications).toEqual([]);
    expect(useAppStateStore.getState().unreadCount).toBe(0);
  });
});
