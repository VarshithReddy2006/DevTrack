// ============================================================================
// userStore.ts — User / Auth Store
// ============================================================================
import { create } from 'zustand';
import type { ApiUser } from '../types/api.types';
import axiosClient from '../utils/axiosClient';

interface UserState {
  user: ApiUser | null;
  isAuthenticated: boolean;
  
  // ── Mutations (synchronous) ──
  setUser: (user: ApiUser) => void;
  clearUser: () => void;
  updateUser: (updates: Partial<ApiUser>) => void;

  // ── Async actions ──
  fetchMe: () => Promise<void>;
  logoutCleanup: () => Promise<void>;
}

export const useUserStore = create<UserState>((set, get) => ({
  user: null,
  isAuthenticated: false,

  setUser: (user) => set({ user, isAuthenticated: true }),
  
  clearUser: () => set({ user: null, isAuthenticated: false }),

  updateUser: (updates) =>
    set((state) => ({
      user: state.user ? { ...state.user, ...updates } : null,
      isAuthenticated: !!(state.user ? { ...state.user, ...updates } : null),
    })),

  fetchMe: async () => {
    try {
      const { data } = await axiosClient.get('/auth/me');
      set({ user: data.data, isAuthenticated: true });
    } catch (err) {
      console.error('Failed to fetch user', err);
      set({ user: null, isAuthenticated: false });
    }
  },

  logoutCleanup: async () => {
    // Clear all per-user data stores to prevent stale data leaking to next user
    const { useDashboardStore } = await import('./dashboardStore');
    const { useDsaStore } = await import('./dsaStore');
    const { useProjectsStore } = await import('./projectsStore');
    useDashboardStore.getState().reset();
    useDsaStore.getState().reset();
    useProjectsStore.getState().reset();

    // Disconnect and clear SSE connections to avoid cross-user event leakage
    try {
      const { useSseStore } = await import('../lib/realtime/sse-manager');
      useSseStore.getState().disconnect();
      useSseStore.getState().clearHistory();
    } catch {
      // ignore
    }

    try {
      const { disconnectGlobalSse } = await import('../hooks/useSse');
      disconnectGlobalSse();
    } catch {
      // ignore
    }

    // Clear profile editing data from localStorage
    localStorage.removeItem('devtrack-profile');

    get().clearUser();
  },
}));
