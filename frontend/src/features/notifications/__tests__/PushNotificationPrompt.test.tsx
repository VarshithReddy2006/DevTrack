import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushNotificationPrompt } from '../components/PushNotificationPrompt';
import { useWebPush, type WebPushStatus } from '../hooks/useWebPush';

vi.mock('../hooks/useWebPush', () => ({ useWebPush: vi.fn() }));
const hook = vi.mocked(useWebPush);
const subscribe = vi.fn();
const unsubscribe = vi.fn();

function withState(status: WebPushStatus, extra: Partial<ReturnType<typeof useWebPush>> = {}) {
  hook.mockReturnValue({ status, checking: false, busy: false, error: null, subscribe, unsubscribe, ...extra });
}

beforeEach(() => {
  localStorage.clear();
  subscribe.mockReset().mockResolvedValue(true);
  unsubscribe.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

describe('PushNotificationPrompt', () => {
  it('renders nothing in browsers without Web Push or while checking', () => {
    withState('unsupported');
    const { container, rerender } = render(<PushNotificationPrompt />);
    expect(container).toBeEmptyDOMElement();
    withState('prompt', { checking: true });
    rerender(<PushNotificationPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers contest alerts with one click', () => {
    withState('prompt');
    render(<PushNotificationPrompt />);
    expect(screen.getByRole('region', { name: 'Never miss a contest start' })).toHaveTextContent('30 minutes before');
    fireEvent.click(screen.getByRole('button', { name: 'Enable alerts' }));
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while turning alerts on', () => {
    withState('prompt', { busy: true });
    render(<PushNotificationPrompt />);
    expect(screen.getByRole('button', { name: 'Turning on…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeDisabled();
  });

  it('remembers "Not now"', () => {
    withState('prompt');
    const { container } = render(<PushNotificationPrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const second = render(<PushNotificationPrompt />);
    expect(second.container).toBeEmptyDOMElement();
  });

  it('shows errors from the hook', () => {
    withState('prompt', { error: "Contest alerts aren't available on the server right now." });
    render(<PushNotificationPrompt />);
    expect(screen.getByRole('alert')).toHaveTextContent("aren't available");
  });

  it('confirms alerts are on and lets the user turn them off', () => {
    withState('subscribed');
    render(<PushNotificationPrompt />);
    expect(screen.getByRole('region', { name: 'Contest alerts are on' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('explains blocked notifications without throwing, and can be dismissed', () => {
    withState('denied');
    const { container } = render(<PushNotificationPrompt />);
    expect(screen.getByRole('region', { name: 'Notifications are blocked' })).toHaveTextContent("site settings");
    expect(screen.queryByRole('button', { name: 'Enable alerts' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss contest alert notice' }));
    expect(container).toBeEmptyDOMElement();
  });
});
