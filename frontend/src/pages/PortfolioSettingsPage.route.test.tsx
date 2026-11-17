import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { AppRouter } from '../router';

const env = vi.hoisted(() => {
  // motion helpers read matchMedia at import time and jsdom does not ship it
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null,
  }));
  return { originalMatchMedia };
});

afterAll(() => { window.matchMedia = env.originalMatchMedia; });
afterEach(cleanup);

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useClerk: () => ({ signOut: vi.fn() }),
  SignedIn: ({ children }: { children: React.ReactNode }) => children,
  SignedOut: () => null,
}));
vi.mock('../components/layout/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return { AppShell: () => (<div data-testid="app-shell"><Outlet /></div>) };
});
vi.mock('./LandingPage', () => ({ LandingPage: () => <h1>Landing</h1> }));
vi.mock('./LoginPage', () => ({ LoginPage: () => <h1>Login</h1> }));
vi.mock('./SignupPage', () => ({ SignupPage: () => <h1>Signup</h1> }));
vi.mock('../services/publicationService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/publicationService')>()),
  fetchPublication: vi.fn().mockResolvedValue({
    published: false, slug: null, sections: {}, publicationVersion: 0, consentVersion: null, publishedAt: null,
  }),
}));

it('serves the portfolio settings at /profile/portfolio', async () => {
  const client = new QueryClient();
  render(
    <MemoryRouter initialEntries={['/profile/portfolio']}>
      <QueryClientProvider client={client}><AppRouter /></QueryClientProvider>
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { name: 'Portfolio Settings' })).toBeInTheDocument();
  expect(screen.getByTestId('app-shell')).toBeInTheDocument();
});
