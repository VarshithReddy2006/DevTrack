import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from './settingsStore';
import { useDashboardStore } from './dashboardStore';
import { getSettings, updateSettings, type UserSettingsResponse } from '../services/settingsService';

vi.mock('../services/settingsService', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
const response = (github = 'old', codeforces = 'old-cf') => ({ platforms: { github: { username: github, lastSyncedAt: '2026-01-01' }, codeforces: { handle: codeforces }, leetcode: { username: 'old-lc' }, codechef: { username: 'old-cc' } } }) as UserSettingsResponse;
const state = () => useSettingsStore.getState();
const githubId = 'platforms.github.username';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  vi.mocked(getSettings).mockResolvedValue(response());
  vi.mocked(updateSettings).mockResolvedValue(response('saved'));
});

describe('settings request lifecycle', () => {
  it('marks the dashboard cache stale only when a handle save succeeds', async () => {
    await state().fetchSettings();
    useDashboardStore.getState().setData({});
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error('offline'));
    state().updateField(githubId, 'saved');
    await state().saveSettings();
    expect(useDashboardStore.getState().lastFetchedAt).not.toBeNull();
    await state().saveSettings();
    expect(useDashboardStore.getState().lastFetchedAt).toBeNull();
  });

  it('blocks immediate duplicate writes before React has rerendered', async () => {
    await state().fetchSettings();
    const pending = deferred<UserSettingsResponse>();
    vi.mocked(updateSettings).mockReturnValue(pending.promise);
    state().updateField(githubId, 'first');
    const saving = state().saveSettings();
    await state().saveSettings();
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ platforms: { github: { username: 'first' } } });
    pending.resolve(response('first')); await saving;
    expect(state().isDirty).toBe(false);
  });

  it('keeps an edit reverted to the original value dirty after the older save completes', async () => {
    await state().fetchSettings();
    const pending = deferred<UserSettingsResponse>();
    vi.mocked(updateSettings).mockReturnValue(pending.promise);
    state().updateField(githubId, 'first');
    const saving = state().saveSettings();
    state().updateField(githubId, 'old');
    expect(state().isDirty).toBe(false);
    pending.resolve(response('first')); await saving;
    expect(state().values[githubId]).toBe('old');
    expect(state().savedValues[githubId]).toBe('first');
    expect(state().isDirty).toBe(true);
  });

  it('retains a different field edited during a save and sends only that remaining change', async () => {
    await state().fetchSettings();
    const pending = deferred<UserSettingsResponse>();
    vi.mocked(updateSettings).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response('first', 'later-cf'));
    state().updateField(githubId, 'first');
    const saving = state().saveSettings();
    state().updateField('platforms.codeforces.handle', 'later-cf');
    pending.resolve(response('first')); await saving;
    expect(state().isDirty).toBe(true);
    await state().saveSettings();
    expect(updateSettings).toHaveBeenLastCalledWith({ platforms: { codeforces: { handle: 'later-cf' } } });
    expect(state().isDirty).toBe(false);
  });

  it('does not overwrite dirty edits when an older refresh finishes', async () => {
    await state().fetchSettings();
    const pending = deferred<UserSettingsResponse>();
    vi.mocked(getSettings).mockReturnValue(pending.promise);
    const loading = state().fetchSettings();
    state().updateField(githubId, 'local-edit');
    pending.resolve(response('remote-value')); await loading;
    expect(state().values[githubId]).toBe('local-edit');
    expect(state().isDirty).toBe(true);
  });

  it('ignores a load that started before a successful save', async () => {
    await state().fetchSettings();
    const pending = deferred<UserSettingsResponse>();
    vi.mocked(getSettings).mockReturnValue(pending.promise);
    const loading = state().fetchSettings();
    state().updateField(githubId, 'saved');
    await state().saveSettings();
    pending.resolve(response('stale')); await loading;
    expect(state().values[githubId]).toBe('saved');
    expect(state().isDirty).toBe(false);
  });

  it.each(['load', 'save'])('does not repopulate reset state after a delayed %s', async kind => {
    await state().fetchSettings();
    const pending = deferred<UserSettingsResponse>();
    let operation: Promise<void>;
    if (kind === 'load') { vi.mocked(getSettings).mockReturnValue(pending.promise); operation = state().fetchSettings(); }
    else { vi.mocked(updateSettings).mockReturnValue(pending.promise); state().updateField(githubId, 'saved'); operation = state().saveSettings(); }
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    pending.resolve(response('delayed')); await operation;
    expect(state()).toMatchObject({ settings: null, isDirty: false, isSaving: false, isLoading: false });
    expect(state().values[githubId]).toBe('');
  });

  it('accepts no unsupported or server-owned edits and sends no no-op save', async () => {
    await state().fetchSettings();
    for (const id of ['appearance.theme', 'workspace.deleteAccount', 'platforms.github.lastSyncedAt']) state().updateField(id, 'unavailable');
    state().updateField(githubId, 123);
    await state().saveSettings();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(state().isDirty).toBe(false);
  });
});
