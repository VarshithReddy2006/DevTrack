import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
});

describe('account boundary', () => {
  it('rehydrates the same account, and does not load legacy shared data', async () => {
    const { prepareAccount } = await import('./accountBoundary');
    const { useProgressionStore } = await import('../store/progressionStore');
    localStorage.setItem('mission-storage', JSON.stringify({ state: { missions: [{ id: 'legacy', notes: 'old private data' }], activeMissionId: 'legacy' }, version: 0 }));
    const reload = vi.fn();
    expect(await prepareAccount('account-a', reload)).toBe(true);
    expect(useProgressionStore.getState().missions.some(m => m.id === 'legacy')).toBe(false);
    useProgressionStore.setState({ activeMissionId: 'account-a-mission' });
    expect(JSON.parse(localStorage.getItem('mission-storage:account-a')!).state.activeMissionId).toBe('account-a-mission');
    vi.resetModules();
    const freshBoundary = await import('./accountBoundary');
    const freshStore = await import('../store/progressionStore');
    expect(await freshBoundary.prepareAccount('account-a', reload)).toBe(true);
    expect(freshStore.useProgressionStore.getState().activeMissionId).toBe('account-a-mission');
    expect(reload).not.toHaveBeenCalled();
  });

  it('requests a reload on direct switch and sign-out before hydrating the next account', async () => {
    const { prepareAccount } = await import('./accountBoundary');
    const { useProgressionStore } = await import('../store/progressionStore');
    const reload = vi.fn();
    await prepareAccount('account-a', reload);
    useProgressionStore.setState({ activeMissionId: 'private-a' });
    localStorage.setItem('mission-storage:account-b', JSON.stringify({ state: { missions: [], activeMissionId: 'private-b' }, version: 0 }));
    expect(await prepareAccount('account-b', reload)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
    expect(useProgressionStore.getState().activeMissionId).toBe('private-a');
    vi.resetModules();
    const next = await import('./accountBoundary');
    const storeB = await import('../store/progressionStore');
    expect(await next.prepareAccount('account-b', reload)).toBe(true);
    expect(storeB.useProgressionStore.getState().activeMissionId).toBe('private-b');
    expect(await next.prepareAccount(null, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('partitions saved notifications by account', async () => {
    localStorage.setItem('devtrack_notifications', JSON.stringify([{ id: 'legacy', read: false }]));
    localStorage.setItem('devtrack_notifications:account-a', JSON.stringify([{ id: 'a', read: false }]));
    localStorage.setItem('devtrack_notifications:account-b', JSON.stringify([{ id: 'b', read: true }]));
    const { prepareAccount } = await import('./accountBoundary');
    const { useAppStateStore } = await import('../store/appStateStore');
    await prepareAccount('account-a', vi.fn());
    expect(useAppStateStore.getState().notifications.map(n => n.id)).toEqual(['a']);
    expect(useAppStateStore.getState().unreadCount).toBe(1);
    await prepareAccount('account-b', vi.fn());
    vi.resetModules();
    const next = await import('./accountBoundary');
    const nextApp = await import('../store/appStateStore');
    await next.prepareAccount('account-b', vi.fn());
    expect(nextApp.useAppStateStore.getState().notifications.map(n => n.id)).toEqual(['b']);
    expect(nextApp.useAppStateStore.getState().unreadCount).toBe(0);
  });

  it('still reloads on an identity change if the tab marker was cleared', async () => {
    const { prepareAccount } = await import('./accountBoundary');
    const reload = vi.fn();
    await prepareAccount('account-a', reload);
    sessionStorage.clear();
    expect(await prepareAccount('account-b', reload)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });
});
