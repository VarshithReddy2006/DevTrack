import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRouter } from './index';

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
vi.mock('../pages/LandingPage', () => ({ LandingPage: () => <h1>Landing</h1> }));
vi.mock('../pages/LoginPage', () => ({ LoginPage: () => <h1>Login</h1> }));
vi.mock('../pages/SignupPage', () => ({ SignupPage: () => <h1>Signup</h1> }));
vi.mock('../pages/FocusPage', () => ({ default: () => <h1>Focus</h1> }));
vi.mock('../pages/DashboardPage', () => ({ default: () => <h1>Dashboard</h1> }));
vi.mock('../pages/admin/BetaDashboardPage', () => ({ default: () => <h1>Beta Dashboard</h1> }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRouter />
    </MemoryRouter>,
  );
}

describe('AppRouter', () => {
  beforeEach(() => { clerk.signedIn = false; });
  afterEach(cleanup);

  it('shows the landing page to signed-out visitors at /', () => {
    renderAt('/');
    expect(screen.getByText('Landing')).toBeTruthy();
  });

  it('redirects signed-out users from protected routes to /login', () => {
    renderAt('/focus');
    expect(screen.getByText('Login')).toBeTruthy();
    expect(screen.queryByText('Focus')).toBeNull();
  });

  it('redirects signed-in users from / to the dashboard inside AppShell', async () => {
    clerk.signedIn = true;
    renderAt('/');
    expect(await screen.findByText('Dashboard')).toBeTruthy();
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });

  it('renders /focus inside AppShell for signed-in users', () => {
    clerk.signedIn = true;
    renderAt('/focus');
    expect(screen.getByText('Focus')).toBeTruthy();
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });

  it('renders /beta/dashboard inside AppShell for signed-in users', async () => {
    clerk.signedIn = true;
    renderAt('/beta/dashboard');
    expect(await screen.findByText('Beta Dashboard')).toBeTruthy();
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });
});
