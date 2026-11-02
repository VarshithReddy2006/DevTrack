import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRouter } from '../router';

const clerk = vi.hoisted(() => {
  // motion helpers read matchMedia at import time and jsdom does not ship it
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null,
  }));
  return { signedIn: false, originalMatchMedia };
});

afterAll(() => { window.matchMedia = clerk.originalMatchMedia; });

vi.mock('@clerk/clerk-react', () => {
  const useAuth = () => ({ isLoaded: true, isSignedIn: clerk.signedIn });
  return {
    useAuth,
    SignedIn: ({ children }: { children: React.ReactNode }) => (clerk.signedIn ? children : null),
    SignedOut: ({ children }: { children: React.ReactNode }) => (clerk.signedIn ? null : children),
  };
});

vi.mock('../components/layout/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return { AppShell: () => (<div data-testid="app-shell"><Outlet /></div>) };
});
vi.mock('./LandingPage', () => ({ LandingPage: () => <h1>Landing</h1> }));
vi.mock('./LoginPage', () => ({ LoginPage: () => <h1>Login</h1> }));
vi.mock('./SignupPage', () => ({ SignupPage: () => <h1>Signup</h1> }));
vi.mock('./DashboardPage', () => ({ default: () => <h1>Dashboard</h1> }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRouter />
    </MemoryRouter>,
  );
}

describe('NotFoundPage routing', () => {
  beforeEach(() => { clerk.signedIn = false; });
  afterEach(cleanup);

  it('shows the 404 page for an unknown URL when signed out', async () => {
    renderAt('/this/page/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Page Not Found' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Return to Dashboard' })).toBeTruthy();
    expect(screen.queryByText('Login')).toBeNull();
  });

  it('shows the 404 page for an unknown URL when signed in, without redirecting', async () => {
    clerk.signedIn = true;
    renderAt('/this/page/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Page Not Found' })).toBeTruthy();
    expect(screen.queryByText('Dashboard')).toBeNull();
  });

  it('Return to Dashboard goes to /dashboard for a signed-in user', async () => {
    clerk.signedIn = true;
    renderAt('/nope');
    fireEvent.click(await screen.findByRole('button', { name: 'Return to Dashboard' }));
    expect(await screen.findByText('Dashboard')).toBeTruthy();
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });

  it('Return to Dashboard hands a signed-out user to the login page', async () => {
    renderAt('/nope');
    fireEvent.click(await screen.findByRole('button', { name: 'Return to Dashboard' }));
    expect(await screen.findByText('Login')).toBeTruthy();
  });

  it('keeps / as the landing page for signed-out visitors', () => {
    renderAt('/');
    expect(screen.getByText('Landing')).toBeTruthy();
    expect(screen.queryByText('Page Not Found')).toBeNull();
  });

  it('still redirects a signed-out user from a protected page to /login', async () => {
    renderAt('/dsa');
    expect(await screen.findByText('Login')).toBeTruthy();
    expect(screen.queryByText('Page Not Found')).toBeNull();
  });
});
