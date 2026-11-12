import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAiInsights } from './useAiInsights';
import { useGoals } from './useGoals';
import { useOnboarding } from './useOnboarding';
import { telemetry } from '../lib/telemetry/analytics';
import { useUserStore } from '../store/userStore';
import axiosClient from '../utils/axiosClient';

vi.mock('../utils/axiosClient', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../lib/telemetry/analytics', () => ({
  telemetry: { track: vi.fn() },
}));

function queryWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  useUserStore.setState(useUserStore.getInitialState(), true);
  vi.resetAllMocks();
});

it('waits for auth before requesting insights or onboarding progress', async () => {
  vi.mocked(axiosClient.get).mockResolvedValue({ data: { success: true, data: [] } });
  const { result } = renderHook(() => ({
    ai: useAiInsights(),
    onboarding: useOnboarding(),
  }), { wrapper: queryWrapper() });

  await act(async () => { await result.current.ai.refetch(); });
  expect(axiosClient.get).not.toHaveBeenCalled();

  act(() => useUserStore.setState({ isAuthenticated: true }));
  await waitFor(() => {
    expect(axiosClient.get).toHaveBeenCalledWith('/observation/insights');
    expect(axiosClient.get).toHaveBeenCalledWith('/onboarding/progress');
  });
});

it('completes the goal and tracks the successful mutation', async () => {
  vi.mocked(axiosClient.get).mockResolvedValue({ data: { data: [] } });
  vi.mocked(axiosClient.post).mockResolvedValue({ data: { success: true } });
  const { result } = renderHook(useGoals, { wrapper: queryWrapper() });

  act(() => result.current.completeGoal('goal-1'));

  await waitFor(() => {
    expect(axiosClient.post).toHaveBeenCalledWith('/goals/goal-1/complete');
    expect(telemetry.track).toHaveBeenCalledExactlyOnceWith('goal_complete', {
      goalId: 'goal-1',
      type: 'mission',
    });
  });
});
