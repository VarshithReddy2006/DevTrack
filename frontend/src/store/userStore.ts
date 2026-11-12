// ============================================================================
// userStore.ts — User / Auth Store
// ============================================================================
import { create } from 'zustand';
import type { ApiUser } from '../types/api.types';
import axiosClient from '../utils/axiosClient';
import { queryClient } from '../lib/queryClient';

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
    // The account boundary reload also unloads the account-scoped persisted stores.
    try {
      const [
        { useDashboardStore }, { useDsaStore }, { useProjectsStore },
        { useProfileStore }, { useSettingsStore }, { useCoachingStore },
        { useUploadState }, { useSessionState }, { useReplayState }, { useIntelligenceState },
        { useAppStateStore, setNotificationAccount },
      ] = await Promise.all([
        import('./dashboardStore'), import('./dsaStore'), import('./projectsStore'),
        import('./profileStore'), import('./settingsStore'), import('./coachingStore'),
        import('../features/resume-tracker/state/useUploadState'),
        import('../features/resume-tracker/state/useSessionState'),
        import('../features/resume-tracker/state/useReplayState'),
        import('../features/resume-tracker/state/useIntelligenceState'),
        import('./appStateStore'),
      ]);

      useDashboardStore.getState().reset();
      useDsaStore.getState().reset();
      useProjectsStore.getState().reset();
      useProfileStore.setState(useProfileStore.getInitialState(), true);
      useSettingsStore.setState(useSettingsStore.getInitialState(), true);
      useCoachingStore.setState(useCoachingStore.getInitialState(), true);
      useUploadState.getState().reset();
      useSessionState.setState(useSessionState.getInitialState(), true);
      useReplayState.getState().resetReplay();
      useIntelligenceState.getState().reset();
      setNotificationAccount(null);
      useAppStateStore.getState().closeDrawer();
      useAppStateStore.getState().clearQueue();
      useAppStateStore.getState().closeModal();
      useAppStateStore.getState().clearToasts();
      useAppStateStore.getState().setLastSseEvent(null);

      // Disconnect and clear SSE connections to avoid cross-user event leakage
      try {
        const { useSseStore } = await import('../lib/realtime/sse-manager');
        useSseStore.getState().disconnect();
        useSseStore.setState({ eventHistory: [], lastEventId: null, lastSequence: null, snapshot: null });
      } catch {
        // ignore
      }

      try {
        const { disconnectGlobalSse } = await import('../hooks/useSse');
        disconnectGlobalSse();
      } catch {
        // ignore
      }
    } finally {
      queryClient.clear();
      try {
        localStorage.removeItem('devtrack-profile');
      } finally {
        get().clearUser();
      }
    }
  },
}));
