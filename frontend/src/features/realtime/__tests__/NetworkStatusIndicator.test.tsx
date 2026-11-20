import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkStatusIndicator } from '../components/NetworkStatusIndicator';
import { useNetworkLatency, type NetworkLatency } from '../../../hooks/useNetworkLatency';
import { getSseDiagnostics, reconnectNow, type SseDiagnostics } from '../../../hooks/useSse';

vi.mock('../../../hooks/useNetworkLatency', () => ({ useNetworkLatency: vi.fn() }));
vi.mock('../../../hooks/useSse', () => ({ getSseDiagnostics: vi.fn(), reconnectNow: vi.fn() }));

const latency = vi.mocked(useNetworkLatency);
const diagnostics = vi.mocked(getSseDiagnostics);
const reconnect = vi.mocked(reconnectNow);
const pingNow = vi.fn();
const NOW = new Date('2026-11-20T10:00:00Z').getTime();

function withLatency(values: Partial<NetworkLatency>) {
  latency.mockReturnValue({ pingMs: 28, lastPingAt: NOW - 3_000, failed: false, pingNow, ...values });
}

function withDiagnostics(values: Partial<SseDiagnostics>) {
  diagnostics.mockReturnValue({
    connectedAt: NOW - 12 * 60_000, lastEventAt: NOW - 40_000, lastHeartbeatAt: NOW - 8_000,
    totalEventsReceived: 9, totalReconnects: 1, consecutiveFailures: 0, avgReconnectDelay: 0, ...values,
  });
}

function pill() {
  return screen.getByRole('button', { name: /Show connection details/ });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  withLatency({});
  withDiagnostics({});
  reconnect.mockReset();
  pingNow.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('NetworkStatusIndicator', () => {
  it('shows a green latency pill for a healthy connection', () => {
    render(<NetworkStatusIndicator status="connected" />);
    expect(pill()).toHaveTextContent('28ms');
    expect(pill()).toHaveAttribute('data-level', 'healthy');
    expect(pill()).toHaveAccessibleName('Connection healthy: 28ms. Show connection details');
    expect(latency).toHaveBeenCalledWith(true);
  });

  it('shows amber for elevated latency and red when it is high', () => {
    withLatency({ pingMs: 180 });
    const { rerender } = render(<NetworkStatusIndicator status="connected" />);
    expect(pill()).toHaveAttribute('data-level', 'degraded');
    withLatency({ pingMs: 450 });
    rerender(<NetworkStatusIndicator status="connected" />);
    expect(pill()).toHaveAttribute('data-level', 'poor');
    expect(pill()).toHaveTextContent('450ms');
  });

  it('goes red and stops pinging as soon as the stream disconnects', () => {
    render(<NetworkStatusIndicator status="disconnected" />);
    expect(pill()).toHaveTextContent('Offline');
    expect(pill()).toHaveAttribute('data-level', 'offline');
    expect(latency).toHaveBeenLastCalledWith(false);
  });

  it('turns amber once the heartbeat is overdue, without waiting for a re-render from the stream', () => {
    withDiagnostics({ lastHeartbeatAt: NOW - 25_000, lastEventAt: null });
    render(<NetworkStatusIndicator status="connected" />);
    expect(pill()).toHaveAttribute('data-level', 'healthy');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(pill()).toHaveAttribute('data-level', 'degraded');
  });

  it('opens connection details on hover and lists ping, uptime, last event and heartbeat', () => {
    render(<NetworkStatusIndicator status="connected" />);
    fireEvent.mouseEnter(pill().parentElement as HTMLElement);
    const details = screen.getByRole('dialog', { name: 'Connection details' });
    expect(pill()).toHaveAttribute('aria-expanded', 'true');
    expect(within(details).getByText('API ping').closest('div')).toHaveTextContent('28ms');
    expect(within(details).getByText('Live stream uptime').closest('div')).toHaveTextContent('12m');
    expect(within(details).getByText('Last event').closest('div')).toHaveTextContent('40s ago');
    expect(within(details).getByText('Last heartbeat').closest('div')).toHaveTextContent('8s ago');
    expect(within(details).queryByRole('button', { name: /Reconnect now/ })).not.toBeInTheDocument();
    expect(details).not.toHaveTextContent('sse-edge-us');
  });

  it('offers Reconnect now while the stream is down', () => {
    render(<NetworkStatusIndicator status="reconnecting" />);
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('button', { name: /Reconnect now/ }));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('offers a fresh ping when the connection is up but degraded', () => {
    withLatency({ pingMs: 220 });
    render(<NetworkStatusIndicator status="connected" />);
    fireEvent.click(pill());
    expect(screen.getByText('Latency to the API is elevated.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Check again/ }));
    expect(pingNow).toHaveBeenCalledTimes(1);
  });

  it('closes the details with Escape', () => {
    render(<NetworkStatusIndicator status="connected" />);
    fireEvent.click(pill());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => { vi.runOnlyPendingTimers(); });
    expect(pill()).toHaveAttribute('aria-expanded', 'false');
  });
});
