import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { InternalAxiosRequestConfig } from 'axios';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRouter } from '../router';
import axiosClient from '../utils/axiosClient';

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
    useClerk: () => ({ signOut: vi.fn() }),
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

const publicProfile = {
  username: 'someone',
  identity: { displayName: 'Some One', levelName: 'Builder' },
  dsa: {
    totalSolved: 312,
    bestContestRating: 1742,
    platformBreakdown: [
      { platform: 'leetcode', solved: 240, rating: 1650 },
      { platform: 'codeforces', solved: 72, rating: 1742 },
    ],
  },
  github: { isVerified: true, verifiedProjectCount: 14 },
  consistency: { currentStreak: 21 },
};

describe('public profile route /u/:username', () => {
  const requests: InternalAxiosRequestConfig[] = [];
  const originalAdapter = axiosClient.defaults.adapter;

  beforeEach(() => {
    requests.length = 0;
    clerk.signedIn = false;
    axiosClient.defaults.adapter = async (config) => {
      requests.push(config);
      return { data: { success: true, data: publicProfile }, status: 200, statusText: 'OK', headers: {}, config };
    };
  });

  afterEach(() => {
    cleanup();
    axiosClient.defaults.adapter = originalAdapter;
  });

  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>,
    );
  }

  it('renders for a signed-out visitor without redirecting to /login', async () => {
    renderAt('/u/someone');
    expect(await screen.findByText('Verified Proof-of-Work')).toBeTruthy();
    expect(await screen.findByText('Some One')).toBeTruthy();
    expect(screen.queryByText('Login')).toBeNull();
  });

  it('fetches the public profile without an Authorization header', async () => {
    renderAt('/u/someone');
    await screen.findByText('Some One');

    const publicCalls = requests.filter((r) => r.url === '/profile/public/someone');
    expect(publicCalls).toHaveLength(1);
    expect(publicCalls[0].headers.Authorization).toBeUndefined();
    // nothing else on this page should hit the owner-only profile endpoints
    expect(requests.filter((r) => r.url === '/profile')).toHaveLength(0);
  });

  it('hides owner-only controls from anonymous viewers', async () => {
    renderAt('/u/someone');
    await screen.findByText('Some One');

    expect(screen.queryByText('Terminate Session')).toBeNull();
    expect(screen.queryByText('Commit Changes')).toBeNull();
    expect(screen.queryByText('Operational Identity')).toBeNull();
    expect(screen.queryByText('Strategic Objectives')).toBeNull();
  });

  it('also hides owner-only controls from a signed-in visitor', async () => {
    clerk.signedIn = true;
    renderAt('/u/someone');
    await screen.findByText('Some One');

    expect(screen.queryByText('Terminate Session')).toBeNull();
    expect(screen.queryByText('Commit Changes')).toBeNull();
    expect(screen.queryByText('Operational Identity')).toBeNull();
  });

  it('shows the not found state when the profile does not exist', async () => {
    axiosClient.defaults.adapter = async (config) => {
      throw { success: false, statusCode: 404, message: 'not found', config };
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderAt('/u/nobody');
    expect(await screen.findByText('Profile Not Found')).toBeTruthy();
    errorSpy.mockRestore();
  });

  it('still sends signed-out visitors from /profile to /login', async () => {
    renderAt('/profile');
    expect(await screen.findByText('Login')).toBeTruthy();
    expect(screen.queryByText('Engineering Profile')).toBeNull();
  });
});
