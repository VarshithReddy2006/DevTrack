import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { useUserStore } from '../store/userStore';
import { useProfileStore } from '../store/profileStore';
import { useDashboardStore } from '../store/dashboardStore';
import { useDsaStore } from '../store/dsaStore';
import { useProjectsStore } from '../store/projectsStore';
import { useUIStore } from '../store/uiStore';
import type { ApiUser } from '../types/api.types';

const clerk = vi.hoisted(() => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null,
  }));
  return {
    originalMatchMedia,
    signedIn: true,
    listeners: new Set<() => void>(),
    signOut: vi.fn(),
  };
});

afterAll(() => { window.matchMedia = clerk.originalMatchMedia; });

vi.mock('@clerk/clerk-react', async () => {
  const { useSyncExternalStore } = await import('react');
  function useAuth() {
    const isSignedIn = useSyncExternalStore(
      (listener) => { clerk.listeners.add(listener); return () => { clerk.listeners.delete(listener); }; },
      () => clerk.signedIn,
    );
    return { isLoaded: true, isSignedIn, userId: isSignedIn ? 'synthetic-clerk-user' : null };
  }
  return {
    useAuth,
    useClerk: () => ({ signOut: clerk.signOut }),
    SignedIn: ({ children }: { children: React.ReactNode }) => useAuth().isSignedIn ? children : null,
    SignedOut: ({ children }: { children: React.ReactNode }) => useAuth().isSignedIn ? null : children,
  };
});

vi.mock('../providers/AppProviders', () => ({ AppProviders: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../lib/accountBoundary', async () => ({ prepareAccount: async (userId: string | null) => {
  if (!userId) await (await import('../lib/signOutBarrier')).waitForSignOut();
  return true;
} }));
vi.mock('../components/layout/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return { AppShell: () => <Outlet /> };
});
vi.mock('./LoginPage', () => ({ LoginPage: () => <h1>Sign in to DevTrack</h1> }));
vi.mock('./SignupPage', () => ({ SignupPage: () => null }));
vi.mock('./LandingPage', () => ({ LandingPage: () => <h1>Welcome to DevTrack</h1> }));
vi.mock('./FocusPage', () => ({ default: () => null }));
vi.mock('../hooks/useDashboardData', () => ({
  useDashboardData: () => ({ data: null, loading: false, error: 'Dashboard unavailable', refetch: vi.fn() }),
}));
vi.mock('../hooks/useDailyChallenge', () => ({ useDailyChallenge: () => ({ challenge: null }) }));
vi.mock('../services/dsaService', () => ({
  fetchDsaContests: vi.fn().mockResolvedValue({ success: true, data: { contests: [] } }),
}));
vi.mock('../components/profile/ProfileHeader', () => ({ ProfileHeader: () => null }));
vi.mock('../components/profile/PersonalInfoCard', () => ({ PersonalInfoCard: () => null }));
vi.mock('../components/profile/CareerGoalsCard', () => ({ CareerGoalsCard: () => null }));
vi.mock('../components/profile/CPProfilesCard', () => ({ CPProfilesCard: () => null }));
vi.mock('../components/profile/PlatformStatsCard', () => ({
  LeetCodeStatsCard: () => null, CodeforcesStatsCard: () => null,
  CodeChefStatsCard: () => null, GithubStatsCard: () => null,
}));
vi.mock('../components/profile/ProfileAchievementsCard', () => ({ ProfileAchievementsCard: () => null }));
vi.mock('../components/profile/SocialProfilesCard', () => ({ SocialProfilesCard: () => null }));

function setSignedIn(value: boolean) {
  clerk.signedIn = value;
  clerk.listeners.forEach(listener => listener());
}

beforeEach(() => {
  clerk.signedIn = true;
  clerk.signOut.mockReset();
  clerk.signOut.mockImplementation(async (onSignedOut: () => Promise<void>) => {
    setSignedIn(false);
    await onSignedOut();
  });
  localStorage.clear();
  localStorage.setItem('devtrack-profile', 'synthetic account data');
  useUserStore.setState({ user: { id: 'synthetic-user' } as ApiUser, isAuthenticated: true, fetchMe: vi.fn().mockResolvedValue(undefined) });
  useProfileStore.setState({ ...useProfileStore.getInitialState(), fetchProfile: vi.fn().mockResolvedValue(undefined) });
  useDashboardStore.getState().setData({ owner: 'synthetic-user' });
  useDsaStore.getState().setStatus('success');
  useProjectsStore.getState().setListStatus('success');
  useUIStore.getState().clearToasts();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clerk.listeners.clear();
  useUserStore.setState(useUserStore.getInitialState());
  useProfileStore.setState(useProfileStore.getInitialState());
  useDashboardStore.getState().reset();
  useDsaStore.getState().reset();
  useProjectsStore.getState().reset();
  useUIStore.getState().clearToasts();
  localStorage.clear();
});

const controls = [
  ['/profile', 'Terminate Session', '/'],
  ['/dashboard', 'Log Out', '/login'],
] as const;

async function openControl(path: string, label: string) {
  window.history.replaceState({}, '', path);
  const view = render(<App />);
  const button = await screen.findByRole('button', { name: label });
  return { ...view, button };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe.each(controls)('%s custom logout', (path, label, redirect) => {
  it('ends the Clerk session, clears existing account stores, and replaces the route', async () => {
    const { button } = await openControl(path, label);
    const historyLength = window.history.length;
    fireEvent.click(button);
    await waitFor(() => expect(clerk.signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.location.pathname).toBe(redirect));
    expect(clerk.signedIn).toBe(false);
    expect(useUserStore.getState().user).toBeNull();
    expect(useUserStore.getState().isAuthenticated).toBe(false);
    expect(useDashboardStore.getState().data).toBeNull();
    expect(useDsaStore.getState().status).toBe('idle');
    expect(useProjectsStore.getState().listStatus).toBe('idle');
    expect(localStorage.getItem('devtrack-profile')).toBeNull();
    expect(window.history.length).toBe(historyLength);
    // A signed-out protected-route visit is rejected by the real App guard.
    await act(async () => {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'Sign in to DevTrack' });
    expect(window.location.pathname).toBe('/login');
    // Recreate the app as on reload; the signed-out boundary still denies entry.
    cleanup();
    window.history.replaceState({}, '', path);
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to DevTrack' });
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  });

  it('preserves the session and local data on rejection, then permits a retry', async () => {
    clerk.signOut.mockRejectedValueOnce(new Error('Synthetic Clerk failure'));
    const { button } = await openControl(path, label);
    fireEvent.click(button);
    await screen.findByText('Could not sign out');
    expect(screen.getByRole('alert').textContent).toContain('Please try again');
    expect(clerk.signedIn).toBe(true);
    expect(useUserStore.getState().isAuthenticated).toBe(true);
    expect(useDashboardStore.getState().data).toEqual({ owner: 'synthetic-user' });
    expect(localStorage.getItem('devtrack-profile')).toBe('synthetic account data');
    expect(window.location.pathname).toBe(path);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(window.location.pathname).toBe(redirect));
    expect(clerk.signOut).toHaveBeenCalledTimes(2);
    expect(useUserStore.getState().user).toBeNull();
  });

  it('blocks repeated clicks and waits for Clerk before clearing local state', async () => {
    const gate = deferred();
    clerk.signOut.mockImplementation(async (callback: () => Promise<void>) => {
      await gate.promise;
      setSignedIn(false);
      await callback();
    });
    const { button } = await openControl(path, label);
    act(() => { button.click(); button.click(); });
    expect(clerk.signOut).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Signing out');
    expect(useUserStore.getState().isAuthenticated).toBe(true);
    expect(localStorage.getItem('devtrack-profile')).not.toBeNull();
    expect(window.location.pathname).toBe(path);
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(window.location.pathname).toBe(redirect));
    expect(localStorage.getItem('devtrack-profile')).toBeNull();
    expect(clerk.signOut).toHaveBeenCalledTimes(1);
  });

  it('finishes cleanup after session changes unmount the protected page', async () => {
    const gate = deferred();
    const originalCleanup = useUserStore.getState().logoutCleanup;
    const cleanupSpy = vi.fn(async () => { await gate.promise; await originalCleanup(); });
    useUserStore.setState({ logoutCleanup: cleanupSpy });
    const { button } = await openControl(path, label);
    fireEvent.click(button);
    await waitFor(() => expect(cleanupSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: /Signing out/ })).toBeNull();
    expect(localStorage.getItem('devtrack-profile')).not.toBeNull();
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(window.location.pathname).toBe(redirect));
    expect(useUserStore.getState().user).toBeNull();
    expect(localStorage.getItem('devtrack-profile')).toBeNull();
  });

  it('keeps a cleanup failure visible after sign-out without restoring authentication', async () => {
    vi.spyOn(useDashboardStore.getState(), 'reset').mockImplementationOnce(() => { throw new Error('Synthetic cleanup failure'); });
    const { button } = await openControl(path, label);
    fireEvent.click(button);
    await screen.findByText('Session ended');
    expect(screen.getByRole('alert').textContent).toContain('Reload before signing in again');
    await waitFor(() => expect(window.location.pathname).toBe(redirect));
    expect(clerk.signedIn).toBe(false);
    expect(useUserStore.getState().user).toBeNull();
    expect(useUserStore.getState().isAuthenticated).toBe(false);
  });
});

it('does not render a custom logout control on the public profile view', async () => {
  const { default: ProfilePage } = await import('./ProfilePage');
  const { MemoryRouter } = await import('react-router-dom');
  render(<MemoryRouter><ProfilePage isPublicView /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: 'Terminate Session' })).toBeNull();
  expect(clerk.signOut).not.toHaveBeenCalled();
});
