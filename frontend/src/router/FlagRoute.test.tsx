import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getErrorCopy } from '../lib/errorCopy';
import { getFlags } from '../services/flagsService';
import axiosClient from '../utils/axiosClient';
import { FlagRoute } from './FlagRoute';

const auth = vi.hoisted(() => ({ isLoaded: true, isSignedIn: true, userId: 'user-a' }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => auth }));
vi.mock('../utils/axiosClient', () => ({ default: { get: vi.fn() } }));

const get = vi.mocked(axiosClient.get);
const response = (data: unknown) => ({ data: { success: true, data } });

beforeEach(() => {
  Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: 'user-a' });
  get.mockReset();
});
afterEach(cleanup);

function mount(options: { redirectTo?: string } = {}, client = new QueryClient()) {
  const router = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/preview']}>
        <Routes>
          <Route path="/preview" element={
            <FlagRoute flagKey="focus_v2" redirectTo={options.redirectTo}>
              <p>Preview content</p>
            </FlagRoute>
          } />
          <Route path="/dashboard" element={<p>Dashboard</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  return { ...render(router()), refresh: router, client };
}

it('waits for auth, loads enabled keys, and reuses cached flags for the same account', async () => {
  auth.isLoaded = false;
  get.mockResolvedValue(response(['focus_v2']));
  const view = mount();
  expect(screen.getByRole('status').textContent).toContain('Checking feature availability');
  expect(get).not.toHaveBeenCalled();
  expect(screen.queryByText('Preview content')).toBeNull();

  auth.isLoaded = true;
  view.rerender(view.refresh());
  expect(await screen.findByText('Preview content')).toBeTruthy();
  expect(get).toHaveBeenCalledWith('/flags', { signal: expect.any(AbortSignal) });
  view.unmount();
  mount({}, view.client);
  expect(screen.getByText('Preview content')).toBeTruthy();
  expect(get).toHaveBeenCalledOnce();
}, 15_000);

it('keeps a previous account’s enabled flags out of a new account', async () => {
  get.mockResolvedValueOnce(response(['focus_v2'])).mockResolvedValueOnce(response({ focus_v2: false }));
  const view = mount();
  expect(await screen.findByText('Preview content')).toBeTruthy();

  auth.userId = 'user-b';
  view.rerender(view.refresh());
  expect(screen.queryByText('Preview content')).toBeNull();
  expect(await screen.findByRole('heading', { name: 'Feature unavailable' })).toBeTruthy();
  expect(get).toHaveBeenCalledTimes(2);
}, 15_000);

it('redirects when the requested flag is absent', async () => {
  get.mockResolvedValue(response(['another-feature']));
  mount({ redirectTo: '/dashboard' });
  expect(await screen.findByText('Dashboard')).toBeTruthy();
  expect(screen.queryByText('Preview content')).toBeNull();
}, 15_000);

it('keeps protected content hidden on a request failure and offers retry', async () => {
  get.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(response(['focus_v2']));
  mount();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('Preview content')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Preview content')).toBeTruthy();
}, 15_000);

it('rejects malformed flag values and maps known and unknown error codes', async () => {
  get.mockResolvedValue(response({ focus_v2: 'true' }));
  await expect(getFlags()).rejects.toThrow();
  expect(getErrorCopy('IDEMPOTENCY_CONFLICT').actionLabel).toBe('Refresh');
  expect(getErrorCopy('constructor')).toEqual(getErrorCopy('INTERNAL_ERROR'));
});
