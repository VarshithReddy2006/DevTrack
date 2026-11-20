// ============================================================================
// queryClient.ts — TanStack Query Configuration
// ============================================================================
// Production-ready query client with caching, retries, and background refetch.
// ============================================================================

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is considered fresh for 60 seconds
      staleTime: 60_000,
      // Keep unused data in cache for 5 minutes
      gcTime: 300_000,
      // Retry failed requests 3 times with exponential backoff
      retry: 3,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      // Refetch in background when window regains focus
      refetchOnWindowFocus: true,
      // Refetch when component mounts (if data is stale)
      refetchOnMount: true,
    },
    mutations: {
      // Retry mutations once
      retry: 1,
    },
  },
});

// Query keys for type-safe cache management
export const queryKeys = {
  dashboard: {
    all: ['dashboard'] as const,
    data: ['dashboard', 'data'] as const,
    stats: ['dashboard', 'stats'] as const,
    streak: ['dashboard', 'streak'] as const,
    platforms: ['dashboard', 'platforms'] as const,
    missions: ['dashboard', 'missions'] as const,
    recentActivity: (limit: number) => ['dashboard', 'recentActivity', limit] as const,
    github: ['dashboard', 'github'] as const,
    achievements: ['dashboard', 'achievements'] as const,
  },
  xp: {
    current: ['xp', 'state'] as const,
  },
  streak: {
    current: ['streak', 'state'] as const,
  },
  missions: {
    active: ['missions', 'active'] as const,
  },
  quests: {
    all: ['quests'] as const,
  },
  achievements: {
    all: ['achievements'] as const,
    detail: (id: string) => ['achievements', id] as const,
  },
  dsa: {
    all: ['dsa'] as const,
    dashboard: ['dsa', 'dashboard'] as const,
    submissions: (filters?: object) => ['dsa', 'submissions', filters] as const,
    contests: (filters?: object) => ['dsa', 'contests', filters] as const,
    topics: ['dsa', 'topics'] as const,
    platformStats: ['dsa', 'platformStats'] as const,
    syncStatus: ['dsa', 'syncStatus'] as const,
  },
  projects: {
    all: ['projects'] as const,
    detail: (id: string) => ['projects', id] as const,
    tasks: (projectId: string) => ['projects', projectId, 'tasks'] as const,
  },
  notifications: {
    list: ['notifications'] as const,
  },
  profile: {
    all: ['profile'] as const,
    stats: ['profile', 'stats'] as const,
  },
  revision: {
    all: ['revision'] as const,
    analytics: ['revision', 'analytics'] as const,
    dueSummary: ['revision', 'due-summary'] as const,
  },
} as const;
