import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlagsDashboard } from '../FeatureFlagsDashboard';
import { FlagAuditTable, formatAuditValue } from '../components/FlagAuditTable';
import { SLIDER_COMMIT_DELAY_MS } from '../components/FlagSlider';
import {
  listAdminFlags,
  listFlagAudit,
  updateAdminFlag,
  type AdminFeatureFlag,
  type FlagAuditEntry,
} from '../../../services/opsFlagsService';

vi.mock('../../../services/opsFlagsService', () => ({
  listAdminFlags: vi.fn(),
  listFlagAudit: vi.fn(),
  updateAdminFlag: vi.fn(),
}));

const list = vi.mocked(listAdminFlags);
const audit = vi.mocked(listFlagAudit);
const update = vi.mocked(updateAdminFlag);

function makeFlag(overrides: Partial<AdminFeatureFlag> = {}): AdminFeatureFlag {
  return {
    key: 'revision', name: 'Revision radar', description: 'Spaced repetition hub', enabled: true,
    rolloutPercent: 30, allowedUserIds: ['000000000000000000000001'], version: 4,
    updatedAt: '2026-11-20T10:00:00.000Z', ...overrides,
  };
}

const auditEntry: FlagAuditEntry = {
  _id: 'a1', flagKey: 'revision', version: 4, actorId: 'u2', actorUsername: 'admin', created: false,
  changes: [{ field: 'rolloutPercent', from: 10, to: 30 }, { field: 'enabled', from: false, to: true }],
  createdAt: '2026-11-20T10:00:00.000Z',
};

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><FeatureFlagsDashboard /></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  list.mockReset().mockResolvedValue([makeFlag(), makeFlag({ key: 'search', name: 'Search', enabled: false, rolloutPercent: 0, allowedUserIds: [], description: '' })]);
  audit.mockReset().mockResolvedValue([auditEntry]);
  update.mockReset().mockImplementation(async (key, changes) => ({ ...makeFlag({ key }), ...changes, version: 5 }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('FeatureFlagsDashboard', () => {
  it('lists each flag with status, description, version and target audience', async () => {
    renderDashboard();
    const flags = await screen.findByRole('list', { name: 'Feature flags' });
    const [revision, search] = within(flags).getAllByRole('listitem');
    expect(revision).toHaveTextContent('Revision radar');
    expect(revision).toHaveTextContent('Active');
    expect(revision).toHaveTextContent('revision · v4');
    expect(revision).toHaveTextContent('Spaced repetition hub');
    expect(revision).toHaveTextContent('Target: 30% of users plus 1 allowlisted');
    expect(search).toHaveTextContent('Inactive');
    expect(search).toHaveTextContent('Target: Nobody (switched off)');
  });

  it('works as an instant kill switch', async () => {
    renderDashboard();
    const toggle = await screen.findByRole('switch', { name: 'Revision radar enabled' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    // Optimistic: the switch flips before the request finishes.
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('revision', { enabled: false }));
  });

  it('saves the rollout once the slider stops moving', async () => {
    renderDashboard();
    const slider = await screen.findByRole('slider', { name: 'Rollout percentage for Revision radar' });
    vi.useFakeTimers();
    fireEvent.change(slider, { target: { value: '40' } });
    fireEvent.change(slider, { target: { value: '55' } });
    fireEvent.change(slider, { target: { value: '70' } });
    expect(slider).toHaveAttribute('aria-valuetext', '70% of users');
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDER_COMMIT_DELAY_MS - 1); });
    expect(update).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('revision', { rolloutPercent: 70 });
  });

  it('does not save when the slider ends where it started', async () => {
    renderDashboard();
    const slider = await screen.findByRole('slider', { name: 'Rollout percentage for Revision radar' });
    vi.useFakeTimers();
    fireEvent.change(slider, { target: { value: '50' } });
    fireEvent.change(slider, { target: { value: '30' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDER_COMMIT_DELAY_MS * 2); });
    expect(update).not.toHaveBeenCalled();
  });

  it('rolls back and explains a failed update, then refreshes the list', async () => {
    update.mockRejectedValueOnce({ message: 'Feature flag cache is unavailable. The flag was not updated.' });
    renderDashboard();
    const toggle = await screen.findByRole('switch', { name: 'Revision radar enabled' });
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('The flag was not updated.');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('refreshes the audit log after a change', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByRole('switch', { name: 'Search enabled' }));
    await waitFor(() => expect(audit).toHaveBeenCalledTimes(2));
  });

  it('shows the recent changes table', async () => {
    renderDashboard();
    const table = await screen.findByRole('table', { name: 'Recent feature flag changes' });
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('revision');
    expect(row).toHaveTextContent('admin');
    expect(row).toHaveTextContent('Rollout: 10% → to 30%');
    expect(row).toHaveTextContent('Status: Inactive → to Active');
  });

  it('shows load errors with a retry and an empty state', async () => {
    list.mockRejectedValueOnce({ message: 'Admin role required' });
    renderDashboard();
    expect(await screen.findByText(/Admin role required/)).toBeInTheDocument();
    list.mockResolvedValueOnce([]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect(await screen.findByText('No feature flags are stored yet.')).toBeInTheDocument();
  });
});

describe('FlagAuditTable', () => {
  it('explains an empty history and marks created flags', () => {
    const { rerender } = render(<FlagAuditTable entries={[]} />);
    expect(screen.getByText('No flag changes have been recorded yet.')).toBeInTheDocument();
    rerender(<FlagAuditTable entries={[{ ...auditEntry, created: true, actorUsername: '', changes: [] }]} />);
    expect(screen.getByText('Created the flag')).toBeInTheDocument();
    expect(screen.getByText('u2')).toBeInTheDocument();
  });

  it('formats each kind of value', () => {
    expect(formatAuditValue('enabled', true)).toBe('Active');
    expect(formatAuditValue('rolloutPercent', 25)).toBe('25%');
    expect(formatAuditValue('allowedUserIds', ['a', 'b'])).toBe('2 users');
    expect(formatAuditValue('allowedUserIds', ['a'])).toBe('1 user');
    expect(formatAuditValue('description', '')).toBe('(empty)');
    expect(formatAuditValue('name', 'Search')).toBe('“Search”');
  });
});
