// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { useDsaData } from './useDsaData';

vi.mock('./useSse', () => ({ useSse: () => ({ connectionStatus: 'connected' }) }));
vi.mock('./useXp', () => ({ useXp: () => ({}) }));
vi.mock('../services/dsaService', () => ({
  fetchDsaDashboard: async () => ({ success: true, data: {
    stats: [{ label: 'Problems Solved', value: '8' }],
    heatmap: [],
    solvedByDifficulty: { easy: 2, medium: 1, hard: 2, unknown: 3 },
    topics: [{ name: 'Arrays', progress: 50 }],
    platformOverview: [{ platform: 'leetcode', stat: 'Solved 7', totalSolved: 7, rank: 42 }],
  } }),
  fetchDsaSubmissions: async () => ({ success: true, data: { submissions: [
    { id: '1', platform: 'leetcode', status: 'accepted', problemName: 'Two Sum', submittedAt: '2026-01-01' },
    { id: '2', platform: 'leetcode', status: 'accepted', problemName: 'Two Sum', submittedAt: '2026-01-01' },
  ] } }),
  fetchDsaContests: async () => ({ success: true, data: { contests: [] } }),
  fetchSchedulerStatus: async () => ({ success: true, data: { status: 'idle' } }),
}));

it('keeps totals, difficulty and topics from the dashboard when paginated submissions contain repeats', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(useDsaData, { wrapper });
  try {
    await waitFor(() => expect(result.current.data?.submissions).toHaveLength(2));
    expect(result.current.data).toMatchObject({
      stats: [{ label: 'Problems Solved', value: '8' }],
      solvedByDifficulty: { easy: 2, medium: 1, hard: 2, unknown: 3 },
      topics: [{ name: 'Arrays', progress: 50 }],
      platformOverview: [{ platform: 'leetcode', totalSolved: 7, rank: '42' }],
    });
  } finally {
    unmount();
    queryClient.clear();
  }
});
