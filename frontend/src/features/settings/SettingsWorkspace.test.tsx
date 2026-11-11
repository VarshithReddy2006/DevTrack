import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsWorkspace } from './SettingsWorkspace';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';
import { getSettings, updateSettings, type UserSettingsResponse } from '../../services/settingsService';

vi.mock('@clerk/clerk-react', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));
vi.mock('../../services/settingsService', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('./components/SystemHealthBar', () => ({ SystemHealthBar: () => null }));
// Exercise the real controls/save flow without waiting on exit animation frames.
vi.mock('framer-motion', async original => ({
  ...await original<typeof import('framer-motion')>(),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));

const initial = (): UserSettingsResponse => ({
  id: 'synthetic-settings', userId: 'synthetic-user',
  platforms: { github: { username: 'old-github', lastSyncedAt: '2026-01-01' }, codeforces: { handle: 'old-cf' }, leetcode: { username: 'old-lc' }, codechef: { username: 'old-cc' } },
  appearance: { theme: 'light', accentColor: '#000000', compactMode: false, showHeatmap: true, heatmapColor: 'green', language: 'en' },
  notifications: { emailNotifications: true, pushNotifications: true, dailyDigest: true, weeklyReport: true, streakReminder: true, missionAlerts: true, projectUpdates: true },
  privacy: { profileVisibility: 'public', showActivity: true, showStreak: true, showProjects: true, showDsaProgress: true },
  createdAt: '', updatedAt: '',
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function githubInput() { return screen.getByPlaceholderText('Enter GitHub username'); }
async function open() { render(<SettingsWorkspace />); await waitFor(() => expect(githubInput()).toHaveProperty('value', 'old-github')); }
function edit(value: string) { fireEvent.change(githubInput(), { target: { value } }); }
function save() { fireEvent.click(screen.getByRole('button', { name: 'Save Now' })); }

beforeEach(() => {
  vi.resetAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useUIStore.getState().clearToasts();
  vi.mocked(getSettings).mockResolvedValue(initial());
  vi.mocked(updateSettings).mockImplementation(async payload => ({ ...initial(), platforms: { ...initial().platforms, ...payload.platforms } }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('settings save workflow', () => {
  it('submits only a changed supported field and retains it on reload', async () => {
    const stored = initial();
    vi.mocked(getSettings).mockImplementation(async () => structuredClone(stored));
    vi.mocked(updateSettings).mockImplementation(async payload => {
      Object.assign(stored.platforms.github, payload.platforms?.github);
      return structuredClone(stored);
    });
    await open(); edit('new-github'); save();
    await waitFor(() => expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ platforms: { github: { username: 'new-github' } } }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    cleanup(); useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    render(<SettingsWorkspace />);
    await waitFor(() => expect(githubInput()).toHaveProperty('value', 'new-github'));
  });

  it('preserves a later edit while a save resolves, then saves that edit separately', async () => {
    const pending = deferred<UserSettingsResponse>();
    vi.mocked(updateSettings).mockReturnValueOnce(pending.promise);
    await open(); edit('first'); save(); edit('later');
    await act(async () => pending.resolve({ ...initial(), platforms: { ...initial().platforms, github: { username: 'first' } } }));
    expect(githubInput()).toHaveProperty('value', 'later');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    save();
    await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith({ platforms: { github: { username: 'later' } } }));
  });

  it('retains failed edits, reports an accessible error and allows retry without retrying forever', async () => {
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error('Synthetic failure'));
    await open(); edit('retry-me'); save();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/try again/i));
    expect(githubInput()).toHaveProperty('value', 'retry-me');
    vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    vi.useRealTimers(); save();
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('discards locally without a refetch and cancels the pending autosave', async () => {
    await open(); edit('discard-me');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(githubInput()).toHaveProperty('value', 'old-github');
    expect(getSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  });

  it('keeps unsupported controls disabled and saves the theme only in this browser', async () => {
    await open();
    const powerUser = screen.getByText('Power User Mode').closest('fieldset');
    expect(powerUser).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(useUIStore.getState().theme).toBe('dark');
    expect(screen.getByText(/saved in this browser/i)).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    const compact = screen.getByText('Compact UI Mode').closest('fieldset');
    expect(compact).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace Management' }));
    for (const button of screen.getAllByRole('button', { name: /Delete|Erase/i })) {
      expect(button.closest('fieldset')).toHaveProperty('disabled', true);
    }
  });

  it('does not change unsupported settings through command-palette toggle shortcuts', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const search = screen.getByPlaceholderText('Search settings, actions...');
    fireEvent.change(search, { target: { value: 'Power User Mode' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(updateSettings).not.toHaveBeenCalled();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('exposes initial load failure and a retry without allowing writes before loading', async () => {
    vi.mocked(getSettings).mockRejectedValueOnce(new Error('Synthetic load failure'));
    render(<SettingsWorkspace />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/load/i));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(githubInput()).toHaveProperty('value', 'old-github'));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('autosaves after the debounce, including an explicitly cleared username', async () => {
    await open(); vi.useFakeTimers(); edit('');
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ platforms: { github: { username: '' } } });
    expect(within(screen.getByText('GitHub Username').closest('fieldset')!).getByRole('textbox')).toHaveProperty('value', '');
  });
});
