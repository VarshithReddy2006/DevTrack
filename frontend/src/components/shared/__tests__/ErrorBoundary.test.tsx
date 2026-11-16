import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Sentry from '@sentry/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';
import { ErrorBoundary as UiErrorBoundary } from '../../ui/ErrorBoundary';

// The ui barrel reads matchMedia at import time and jsdom does not ship it.
const originalMatchMedia = vi.hoisted(() => {
  const original = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null,
  }));
  return original;
});

afterAll(() => { window.matchMedia = originalMatchMedia; });

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  isInitialized: vi.fn(() => true),
  captureReactException: vi.fn(() => 'evt-123'),
  captureFeedback: vi.fn(() => 'fb-1'),
}));

let shouldThrow = true;

function Broken() {
  if (shouldThrow) throw new Error('render exploded');
  return <p>all good</p>;
}

beforeEach(() => {
  shouldThrow = true;
  vi.mocked(Sentry.isInitialized).mockReturnValue(true);
  // React logs caught render errors; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    shouldThrow = false;
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(Sentry.captureReactException).not.toHaveBeenCalled();
  });

  it('shows an accessible fallback and reports the crash with its component stack', () => {
    const onError = vi.fn();
    render(<ErrorBoundary pageName="Projects" onError={onError}><Broken /></ErrorBoundary>);

    expect(screen.getByRole('alert')).toHaveTextContent('Projects Error');
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();

    expect(Sentry.captureReactException).toHaveBeenCalledTimes(1);
    const [error, info] = vi.mocked(Sentry.captureReactException).mock.calls[0];
    expect((error as Error).message).toBe('render exploded');
    expect(info.componentStack).toContain('Broken');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('still shows the fallback, without a report button, when Sentry is off', () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Report an issue' })).not.toBeInTheDocument();
    expect(Sentry.captureReactException).not.toHaveBeenCalled();
  });

  it('Try Again resets the boundary and renders the children again', () => {
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports again if the retry crashes too', () => {
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(Sentry.captureReactException).toHaveBeenCalledTimes(2);
  });

  it('uses a custom fallback when one is given', () => {
    render(
      <ErrorBoundary fallback={(error, reset) => <button onClick={reset}>custom: {error.message}</button>}>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'custom: render exploded' })).toBeInTheDocument();
    expect(Sentry.captureReactException).toHaveBeenCalledTimes(1);
  });
});

describe('feedback dialog', () => {
  function openDialog() {
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: 'Report an issue' }));
    return screen.getByRole('dialog', { name: 'Report an issue' });
  }

  it('sends a scrubbed note tied to the crash event', async () => {
    openDialog();
    const send = screen.getByRole('button', { name: 'Send report' });
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByLabelText('What were you doing?'), {
      target: { value: 'Saving my profile as jane@example.com' },
    });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    expect(Sentry.captureFeedback).toHaveBeenCalledWith({
      message: 'Saving my profile as [redacted-email]',
      associatedEventId: 'evt-123',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Thanks, your report was sent.');
  });

  it('tells the user when the report could not be sent and lets them retry', () => {
    openDialog();
    vi.mocked(Sentry.captureFeedback).mockImplementationOnce(() => { throw new Error('offline'); });
    fireEvent.change(screen.getByLabelText('What were you doing?'), { target: { value: 'clicking save' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(screen.getByText('We could not send the report. Please try again.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(Sentry.captureFeedback).toHaveBeenCalledTimes(2);
  });

  it('closes on Cancel without sending anything', async () => {
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(Sentry.captureFeedback).not.toHaveBeenCalled();
  });
});

describe('ui/ErrorBoundary', () => {
  it('reports crashes too', () => {
    render(<UiErrorBoundary><Broken /></UiErrorBoundary>);
    expect(Sentry.captureReactException).toHaveBeenCalledTimes(1);
  });
});
