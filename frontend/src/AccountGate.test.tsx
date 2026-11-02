import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthSyncGate } from './App';
import { useEffect, useState } from 'react';

const state = vi.hoisted(() => ({ userId: 'account-a', prepare: vi.fn(), fetch: vi.fn() }));
vi.hoisted(() => { window.matchMedia = vi.fn().mockReturnValue({ matches: false }); });
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: !!state.userId, userId: state.userId }) }));
vi.mock('./lib/accountBoundary', () => ({ prepareAccount: state.prepare }));
vi.mock('./store/userStore', () => ({ useUserStore: (selector: (value: unknown) => unknown) => selector({ user: null, fetchMe: state.fetch }) }));
vi.mock('./providers/AppProviders', () => ({ AppProviders: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./router', () => ({ AppRouter: () => null }));
vi.mock('./components/shared/ToastContainer', () => ({ ToastContainer: () => null }));
vi.mock('framer-motion', () => ({ motion: { div: ({ children }: any) => <div>{children}</div>, span: ({ children }: any) => <span>{children}</span> } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); state.userId = 'account-a'; });

it('hides the old account immediately while a direct account switch is prepared', async () => {
  state.prepare.mockResolvedValueOnce(true);
  let finish!: (value: boolean) => void;
  state.prepare.mockReturnValueOnce(new Promise<boolean>(resolve => { finish = resolve; }));
  const page = render(<AuthSyncGate><div>Account A private dashboard</div></AuthSyncGate>);
  await screen.findByText('Account A private dashboard');
  state.userId = 'account-b';
  page.rerender(<AuthSyncGate><div>Account A private dashboard</div></AuthSyncGate>);
  expect(screen.queryByText('Account A private dashboard')).toBeNull();
  await waitFor(() => expect(state.prepare).toHaveBeenCalledWith('account-b', undefined, expect.any(Function)));
  await act(async () => { finish(false); });
  expect(screen.queryByText('Account A private dashboard')).toBeNull();
});

it('keeps a delayed old-account response hidden during the reload boundary', async () => {
  let deliver!: (value: string) => void;
  const response = new Promise<string>(resolve => { deliver = resolve; });
  function Dashboard() {
    const [data, setData] = useState('waiting');
    useEffect(() => { void response.then(setData); }, []);
    return <div>{data}</div>;
  }
  state.prepare.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const page = render(<AuthSyncGate><Dashboard /></AuthSyncGate>);
  await screen.findByText('waiting');
  state.userId = 'account-b';
  page.rerender(<AuthSyncGate><Dashboard /></AuthSyncGate>);
  await act(async () => { deliver('account-a private data'); await response; });
  expect(screen.queryByText('account-a private data')).toBeNull();
});
