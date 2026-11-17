import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationDrawer } from './NotificationDrawer';
import { useNotificationStore } from '../../store/notificationStore';

const originalMatchMedia = vi.hoisted(() => {
  const original = window.matchMedia;
  window.matchMedia = vi.fn((media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }) as unknown as MediaQueryList);
  return original;
});

afterAll(() => { window.matchMedia = originalMatchMedia; });

beforeEach(() => {
  useNotificationStore.setState({
    notifications: [
      { id: 'n1', type: 'xp_updated', title: 'You earned XP', body: 'Nice', createdAt: Date.now(), read: false, priority: 'low' },
    ] as never,
    unreadCount: 1,
  });
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button>background before</button>
      <button onClick={() => setOpen(true)}>Open notifications</button>
      <NotificationDrawer open={open} onClose={() => setOpen(false)} />
      <button>background after</button>
    </div>
  );
}

function openDrawer() {
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open notifications' });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole('dialog', { name: 'Notifications' }) };
}

describe('NotificationDrawer keyboard behaviour', () => {
  it('moves focus into the drawer when it opens', () => {
    const { dialog } = openDrawer();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toBe(dialog);
  });

  it('keeps Tab inside the drawer when tabbing past the last control', async () => {
    const { dialog } = openDrawer();
    const controls = within(dialog).getAllByRole('button');
    const first = controls[0];
    const last = controls[controls.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('wraps Shift+Tab from the first control to the last one', async () => {
    const { dialog } = openDrawer();
    const controls = within(dialog).getAllByRole('button');
    controls[0].focus();
    fireEvent.keyDown(controls[0], { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(controls[controls.length - 1]);
  });

  it('pulls focus back in when it was somewhere on the page behind the drawer', async () => {
    const { dialog } = openDrawer();
    const outside = screen.getByRole('button', { name: 'background after' });
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Tab' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('closes on Escape from anywhere (document level), not only while a drawer control has focus', async () => {
    const { opener } = openDrawer();
    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('returns focus to the opener after Escape with focus inside the drawer', async () => {
    const { opener } = openDrawer();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('returns focus to the opener when closed with the close button', async () => {
    const { opener } = openDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Close notifications' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('locks body scroll while open and restores it on close', async () => {
    document.body.style.overflow = 'auto';
    openDrawer();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.body.style.overflow).toBe('auto'));
  });
});
