import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemHealthBar, platformStatus } from './SystemHealthBar';
import { getApiHealth, getPlatformSyncStatuses } from '../../../services/systemHealthService';

vi.mock('../../../services/systemHealthService', () => ({
  getApiHealth: vi.fn(), getPlatformSyncStatuses: vi.fn(),
}));

const syncedAt = new Date(Date.now() - 5 * 60_000).toISOString();
const github = { platformName: 'GitHub', isConnected: true, syncStatus: 'success', lastSyncedAt: syncedAt };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getApiHealth).mockResolvedValue({ health: { status: 'ok', degraded: false }, latencyMs: 82 });
  vi.mocked(getPlatformSyncStatuses).mockResolvedValue([github]);
});
afterEach(cleanup);

describe('system health status', () => {
  it('dismisses on outside pointer presses and keeps the panel open for inside presses', async () => {
    render(<><button type="button">Outside</button><SystemHealthBar /></>);
    await screen.findByText('2/5 healthy');
    const toggle = screen.getByRole('button', { name: 'Show system status' });
    fireEvent.click(toggle);
    fireEvent.pointerDown(screen.getByRole('heading', { name: 'System Status' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('heading', { name: 'System Status' })).toBeNull();
  });

  it('dismisses on Escape and restores focus to the toggle', async () => {
    render(<SystemHealthBar />);
    await screen.findByText('2/5 healthy');
    const toggle = screen.getByRole('button', { name: 'Show system status' });
    fireEvent.click(toggle);
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    refresh.focus();
    fireEvent.keyDown(refresh, { key: 'Escape' });

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('shows measured API latency, actual sync time and disconnected platforms', async () => {
    render(<SystemHealthBar />);
    await waitFor(() => expect(screen.getByText('2/5 healthy')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Show system status' }));
    expect(screen.getByText('Responding · 82ms')).toBeTruthy();
    expect(screen.getByText('Last synced 5m ago')).toBeTruthy();
    expect(screen.getAllByText('Not connected')).toHaveLength(3);
    expect(screen.queryByText(/45ms|14s ago/)).toBeNull();
  });

  it('does not present failed or unauthorized requests as healthy and retries on refresh', async () => {
    vi.mocked(getApiHealth).mockRejectedValueOnce(new Error('timeout'));
    vi.mocked(getPlatformSyncStatuses).mockRejectedValueOnce({ statusCode: 401 });
    render(<SystemHealthBar />);
    await waitFor(() => expect(screen.getByText('0/5 healthy')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Show system status' }));
    expect(screen.getByText('Health check unavailable')).toBeTruthy();
    expect(screen.getAllByText('Sync status unavailable')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Retry API check' }));
    await waitFor(() => expect(screen.getByText('2/5 healthy')).toBeTruthy());
    expect(getApiHealth).toHaveBeenCalledTimes(2);
    expect(getPlatformSyncStatuses).toHaveBeenCalledTimes(2);
  });

  it('shows degraded API separately from a successful platform sync', async () => {
    vi.mocked(getApiHealth).mockResolvedValue({ health: { status: 'degraded', degraded: true }, latencyMs: 120 });
    render(<SystemHealthBar />);
    await waitFor(() => expect(screen.getByText('1/5 healthy')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Show system status' }));
    expect(screen.getByText('Degraded · 120ms')).toBeTruthy();
  });

  it('distinguishes syncing, failed, stale and missing sync timestamps', () => {
    expect(platformStatus({ ...github, syncStatus: 'syncing' }).status).toBe('syncing');
    expect(platformStatus({ ...github, syncStatus: 'error' }).status).toBe('error');
    expect(platformStatus({ ...github, lastSyncedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }).status).toBe('warning');
    expect(platformStatus({ ...github, lastSyncedAt: null }).status).toBe('unknown');
  });
});
