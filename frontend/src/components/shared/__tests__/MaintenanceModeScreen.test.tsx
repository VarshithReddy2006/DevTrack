import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceModeScreen, formatCountdown } from '../MaintenanceModeScreen';
import { checkApiReady } from '../../../services/systemHealthService';
import { useMaintenanceStore } from '../../../store/maintenanceStore';

vi.mock('../../../services/systemHealthService', () => ({ checkApiReady: vi.fn() }));
const ready = vi.mocked(checkApiReady);

function renderScreen() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  render(
    <QueryClientProvider client={client}>
      <p>Dashboard content</p>
      <MaintenanceModeScreen />
    </QueryClientProvider>,
  );
  return { invalidate };
}

/** Let the pending readiness promise settle inside act. */
async function flush() {
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
  ready.mockReset();
});
afterEach(() => {
  cleanup();
  useMaintenanceStore.getState().exit();
  vi.useRealTimers();
});

describe('formatCountdown', () => {
  it('formats minutes and seconds', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(600)).toBe('10:00');
  });
});

describe('MaintenanceModeScreen', () => {
  it('stays hidden until maintenance starts', () => {
    renderScreen();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => useMaintenanceStore.getState().enter(60));
    expect(screen.getByRole('dialog', { name: "We'll be right back" })).toHaveAccessibleDescription(/scheduled upgrades/);
    expect(screen.getByRole('timer')).toHaveTextContent('1:00');
    expect(screen.getByRole('button', { name: /Check Again Now/ })).toHaveFocus();
  });

  it('counts down every second', () => {
    useMaintenanceStore.getState().enter(60);
    renderScreen();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('timer')).toHaveTextContent('0:57');
    expect(ready).not.toHaveBeenCalled();
  });

  it('checks readiness at zero and restores the app without a reload', async () => {
    ready.mockResolvedValue(true);
    useMaintenanceStore.getState().enter(5);
    const { invalidate } = renderScreen();
    act(() => { vi.advanceTimersByTime(5000); });
    await flush();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Dashboard content')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(useMaintenanceStore.getState().active).toBe(false);
  });

  it('backs off and keeps waiting when the API is still down', async () => {
    ready.mockResolvedValue(false);
    useMaintenanceStore.getState().enter(10);
    renderScreen();
    act(() => { vi.advanceTimersByTime(10_000); });
    await flush();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('0:20');
    expect(screen.getByText(/Still upgrading/)).toBeInTheDocument();
  });

  it('checks right away with Check Again Now', async () => {
    let finish: (value: boolean) => void = () => {};
    ready.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    useMaintenanceStore.getState().enter(60);
    const { invalidate } = renderScreen();
    fireEvent.click(screen.getByRole('button', { name: /Check Again Now/ }));
    expect(screen.getByRole('button', { name: /Checking/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Checking/ }));
    expect(ready).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(invalidate).toHaveBeenCalled();
  });

  it('cannot be dismissed with Escape', () => {
    useMaintenanceStore.getState().enter(60);
    renderScreen();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
