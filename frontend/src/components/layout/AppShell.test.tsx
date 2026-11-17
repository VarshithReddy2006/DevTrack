import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

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

vi.mock('@clerk/clerk-react', () => ({ UserButton: () => <button>Account</button> }));
vi.mock('../../hooks/useSse', () => ({
  useSse: () => ({ connectionStatus: 'disconnected', diagnostics: null, eventHistory: [] }),
}));
vi.mock('../../hooks/useRuntimeState', () => ({ useRuntimeState: () => ({ data: undefined }) }));
vi.mock('../../runtime-intelligence/useSyncIntelligence', () => ({ useSyncIntelligence: () => undefined }));
vi.mock('../../features/onboarding', () => ({ OnboardingModal: () => null }));
vi.mock('../shared/ThemeToggle', () => ({ ThemeToggle: () => null }));

afterAll(() => { window.matchMedia = originalMatchMedia; });

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

function renderShell() {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <AppShell />
    </MemoryRouter>
  );
}

function openPalette() {
  renderShell();
  const opener = screen.getAllByRole('button', { name: /Show my hardest problems/ })[0];
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole('dialog', { name: 'Command palette' }) };
}

describe('command palette keyboard behaviour', () => {
  it('focuses the search input when the palette opens', () => {
    const { dialog } = openPalette();
    expect(within(dialog).getByPlaceholderText('Where do you want to go?')).toHaveFocus();
  });

  it('keeps Tab inside the palette when tabbing past the last control', async () => {
    const user = userEvent.setup();
    const { dialog } = openPalette();
    const controls = within(dialog).getAllByRole('button');
    const last = controls[controls.length - 1];
    expect(last).toHaveTextContent('Advanced search');
    last.focus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(within(dialog).getByPlaceholderText('Where do you want to go?'));
  });

  it('wraps Shift+Tab from the first control to the last one', async () => {
    const user = userEvent.setup();
    const { dialog } = openPalette();
    within(dialog).getByPlaceholderText('Where do you want to go?').focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toHaveTextContent('Advanced search');
  });

  it('closes on Escape from anywhere (document level) and returns focus to the opener', async () => {
    const { opener } = openPalette();
    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('returns focus to the focused element when opened with Ctrl+K', async () => {
    renderShell();
    const toggle = screen.getAllByRole('button', { name: /Show my hardest problems/ })[0];
    toggle.focus();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it('locks body scroll while open and restores it on close', async () => {
    document.body.style.overflow = 'auto';
    openPalette();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.body.style.overflow).toBe('auto'));
  });

  it('still navigates and closes when a palette item is chosen', async () => {
    const { dialog } = openPalette();
    fireEvent.click(within(dialog).getByRole('button', { name: /Settings/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('notifications drawer inside the app shell', () => {
  it('opens from the bell, traps Tab, and returns focus to the bell on Escape', async () => {
    const user = userEvent.setup();
    renderShell();
    const bell = screen.getAllByRole('button', { name: /^Notifications/ })[0];
    bell.focus();
    fireEvent.click(bell);
    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    expect(document.body.style.overflow).toBe('hidden');
    const controls = within(dialog).getAllByRole('button');
    controls[controls.length - 1].focus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(bell).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
  });
});
