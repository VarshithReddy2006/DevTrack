import { create } from 'zustand';
import type {
  ProfileData,
  LeetCodeStats,
  CodeforcesStats,
  CodeChefStats,
  GithubStats,
  PlatformState,
} from '../types/profile.types';
import { DEFAULT_PROFILE, EMPTY_PLATFORM_STATE } from '../types/profile.types';
import {
  connectPlatform,
  syncAllPlatforms as syncAllPlatformsApi,
  getProfile as getProfileApi,
  updateProfile as updateProfileApi
} from '../services/profileService';
import type { ApiPlatformStats, ApiUserProfile, ApiProfileUpdatePayload } from '../types/api.types';
import { type GithubDashboardStats } from '../services/dashboardService';

// ---------------------------------------------------------------------------
// STORE INTERFACE
// ---------------------------------------------------------------------------

type SyncState = 'idle' | 'syncing' | 'success' | 'error';

interface ProfileStore {
  // Profile data
  profile: ProfileData;

  // Platform stats (derived from dashboard data)
  leetcode: PlatformState<LeetCodeStats>;
  codeforces: PlatformState<CodeforcesStats>;
  codechef: PlatformState<CodeChefStats>;
  github: PlatformState<GithubStats>;

  // Sync lifecycle
  syncState: SyncState;
  syncMessage: string | null;
  lastSyncedAt: string | null;
  syncingPlatform: string | null;
  syncProgressPercent: number;
  syncTimeRemaining: number | null;

  // Dirty tracking
  isDirty: boolean;
  isSaving: boolean;
  saveError: string | null;
  isLoading: boolean;

  // Actions: Profile editing
  fetchProfile: () => Promise<void>;
  saveProfile: () => Promise<void>;
  updateField: <K extends keyof ProfileData>(field: K, value: ProfileData[K]) => void;
  addTechStack: (tag: string) => void;
  removeTechStack: (tag: string) => void;

  // Actions: Sync (triggers backend sync, then invalidates dashboard)
  fetchAllPlatforms: () => Promise<{ success: boolean; results?: any[] | null; message: string }>;
  clearSyncMessage: () => void;

  // Actions: Populate stats from dashboard data (called by ProfilePage)
  populateFromDashboard: (platforms: ApiPlatformStats[], githubStats?: GithubDashboardStats | null) => void;
}

// ---------------------------------------------------------------------------
// MAPPING HELPERS: API -> Frontend
// ---------------------------------------------------------------------------

function mapApiToProfileData(api: ApiUserProfile): ProfileData {
  const a = api;
  return {
    fullName: api.displayName,
    email: api.email,
    role: a.roleTitle || 'Full Stack Developer',
    bio: api.bio || '',
    location: a.location || '',
    targetRole: a.targetRole || '',
    targetCompanies: (a.targetCompanies || []).join(', '),
    techStack: a.techStack || [],
    githubUrl: api.socialLinks.github || '',
    linkedinUrl: api.socialLinks.linkedin || '',
    portfolioUrl: api.socialLinks.portfolio || '',
    leetcodeUsername: api.socialLinks.leetcode || '',
    codeforcesUsername: api.socialLinks.codeforces || '',
    codechefUsername: api.socialLinks.codechef || '',
  };
}

function mapProfileDataToApi(data: ProfileData): ApiProfileUpdatePayload {
  return {
    displayName: data.fullName,
    bio: data.bio,
    roleTitle: data.role,
    location: data.location,
    techStack: data.techStack,
    targetRole: data.targetRole,
    targetCompanies: data.targetCompanies.split(',').map(s => s.trim()).filter(Boolean),
    socialLinks: {
      github: data.githubUrl || null,
      linkedin: data.linkedinUrl || null,
      portfolio: data.portfolioUrl || null,
      leetcode: data.leetcodeUsername || null,
      codeforces: data.codeforcesUsername || null,
      codechef: data.codechefUsername || null,
      twitter: null,
    }
  };
}

// ---------------------------------------------------------------------------
// STORE
// ---------------------------------------------------------------------------

export const useProfileStore = create<ProfileStore>((set, get) => ({
  profile: { ...DEFAULT_PROFILE },

  leetcode: EMPTY_PLATFORM_STATE<LeetCodeStats>(),
  codeforces: EMPTY_PLATFORM_STATE<CodeforcesStats>(),
  codechef: EMPTY_PLATFORM_STATE<CodeChefStats>(),
  github: EMPTY_PLATFORM_STATE<GithubStats>(),

  syncState: 'idle',
  syncMessage: null,
  lastSyncedAt: null,
  syncingPlatform: null,
  syncProgressPercent: 0,
  syncTimeRemaining: null,

  isDirty: false,
  isSaving: false,
  saveError: null,
  isLoading: false,

  // ─── Fetch profile from API ──────────────────────────────────────────
  fetchProfile: async () => {
    const startedWith = get().profile;
    set({ isLoading: true });
    try {
      const response = await getProfileApi();
      const apiProfile = response.data.data as ApiUserProfile;
      // A delayed load must not discard edits made after it started.
      set(state => state.profile === startedWith ? {
        profile: mapApiToProfileData(apiProfile),
        isDirty: false,
        saveError: null,
        isLoading: false,
      } : { isLoading: false });
    } catch (error) {
      console.error('Failed to fetch profile:', error);
      set({ isLoading: false });
    }
  },

  // ─── Save profile to API ────────────────────────────────────────────
  saveProfile: async () => {
    if (get().isSaving) return;
    const { profile } = get();
    set({ isSaving: true, saveError: null });
    try {
      const payload = mapProfileDataToApi(profile);
      const response = await updateProfileApi(payload);
      const savedProfile = response?.data?.data ? mapApiToProfileData(response.data.data as ApiUserProfile) : profile;
      set(state => ({
        profile: state.profile === profile ? savedProfile : state.profile,
        isDirty: state.profile === profile ? false : state.isDirty,
        isSaving: false,
        saveError: null,
      }));
    } catch (error) {
      console.error('Failed to save profile:', error);
      set({ isSaving: false, saveError: 'Could not save profile. Your changes are still unsaved. Please check the fields and try again.' });
    }
  },

  // ─── Update single field ────────────────────────────────────────────
  updateField: (field, value) => {
    set((state) => ({
      profile: { ...state.profile, [field]: value },
      isDirty: true,
    }));
  },

  // ─── Tech stack tags ────────────────────────────────────────────────
  addTechStack: (tag) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    set((state) => {
      if (state.profile.techStack.includes(trimmed)) return state;
      return {
        profile: {
          ...state.profile,
          techStack: [...state.profile.techStack, trimmed],
        },
        isDirty: true,
      };
    });
  },

  removeTechStack: (tag) => {
    set((state) => ({
      profile: {
        ...state.profile,
        techStack: state.profile.techStack.filter((t) => t !== tag),
      },
      isDirty: true,
    }));
  },

  // ─── Clear sync feedback message ────────────────────────────────────
  clearSyncMessage: () => set({ syncMessage: null }),

  // ─── Populate platform stats from dashboard data ────────────────────
  populateFromDashboard: (platforms: ApiPlatformStats[], githubStats?: GithubDashboardStats | null) => {
    const now = Date.now();

    // Reset all first
    const lc = EMPTY_PLATFORM_STATE<LeetCodeStats>();
    const cf = EMPTY_PLATFORM_STATE<CodeforcesStats>();
    const cc = EMPTY_PLATFORM_STATE<CodeChefStats>();
    const gh = EMPTY_PLATFORM_STATE<GithubStats>();

    for (const p of platforms) {
      const name = p.platformName.toLowerCase();
      if (name === 'leetcode') {
        Object.assign(lc, { data: mapToLeetCodeStats(p), loading: false, lastFetchedAt: now });
      } else if (name === 'codeforces') {
        Object.assign(cf, { data: mapToCodeforcesStats(p), loading: false, lastFetchedAt: now });
      } else if (name === 'codechef') {
        Object.assign(cc, { data: mapToCodeChefStats(p), loading: false, lastFetchedAt: now });
      } else if (name === 'github') {
        const data = githubStats ? {
          username: p.username,
          publicRepos: githubStats.repos,
          followers: githubStats.followers,
          following: githubStats.following,
          totalStars: githubStats.totalStars,
          topLanguages: githubStats.topLanguages,
          createdAt: githubStats.lastSyncedAt,
          updatedAt: githubStats.lastSyncedAt,
        } : mapToGithubStats(p);

        Object.assign(gh, { data, loading: false, lastFetchedAt: now });
      }
    }

    set({ leetcode: lc, codeforces: cf, codechef: cc, github: gh });
  },

  // ─── Sync All Platforms ─────────────────────────────────────────────
  fetchAllPlatforms: async () => {
    // If there are unsaved profile edits, save them first
    if (get().isDirty) {
      try {
        await get().saveProfile();
      } catch (err) {
        console.warn('Auto-save profile before sync failed:', err);
      }
    }

    const { profile } = get();

    // Reset gamification session XP totals before starting sync
    try {
      const { useGamificationStore } = await import('./gamificationStore');
      useGamificationStore.getState().resetSessionXpTotal();
    } catch (e) {
      console.error('Failed to reset gamification session total:', e);
    }

    const getGithubUsername = (url: string) => {
      if (!url) return '';
      const trimmed = url.trim();
      if (!trimmed.includes('/')) return trimmed;
      // Handle https://github.com/username or github.com/username
      return trimmed.split('/').filter(Boolean).pop() || '';
    };

    const platformMap: [string, string][] = [
      ['leetcode', (profile.leetcodeUsername || '').trim()],
      ['codeforces', (profile.codeforcesUsername || '').trim()],
      ['codechef', (profile.codechefUsername || '').trim()],
      ['github', getGithubUsername(profile.githubUrl || '')],
    ];

    const platformsToConnect = platformMap.filter(([, username]) => username.length > 0);
    const activePlatforms = platformsToConnect.map(([name]) => name);

    if (activePlatforms.length === 0) {
      set({
        syncState: 'error',
        syncMessage: 'Please enter at least one platform username to sync.',
      });
      return {
        success: false,
        results: null,
        message: 'Please enter at least one platform username to sync.',
      };
    }

    let progressPercent = 5;
    let timeRemaining = Math.max(4, activePlatforms.length * 2);

    set({
      syncState: 'syncing',
      syncMessage: null,
      syncingPlatform: activePlatforms[0] || null,
      syncProgressPercent: progressPercent,
      syncTimeRemaining: timeRemaining,
      leetcode: activePlatforms.includes('leetcode') ? { ...get().leetcode, loading: true, error: null } : { ...get().leetcode, loading: false },
      codeforces: activePlatforms.includes('codeforces') ? { ...get().codeforces, loading: true, error: null } : { ...get().codeforces, loading: false },
      codechef: activePlatforms.includes('codechef') ? { ...get().codechef, loading: true, error: null } : { ...get().codechef, loading: false },
      github: activePlatforms.includes('github') ? { ...get().github, loading: true, error: null } : { ...get().github, loading: false },
    });

    // Start progress simulator
    const progressInterval = setInterval(() => {
      const currentStoreState = get();
      if (currentStoreState.syncState !== 'syncing') {
        clearInterval(progressInterval);
        return;
      }

      // Step up the progress percent and estimated time remaining
      progressPercent = Math.min(95, progressPercent + Math.floor(Math.random() * 8) + 4);
      if (timeRemaining > 1) {
        timeRemaining -= 1;
      }

      // Map progress to active platforms
      const platformStep = 95 / Math.max(1, activePlatforms.length);
      const index = Math.min(activePlatforms.length - 1, Math.floor(progressPercent / platformStep));
      const currentPlatform = activePlatforms[index] || null;

      set({
        syncProgressPercent: progressPercent,
        syncTimeRemaining: timeRemaining,
        syncingPlatform: currentPlatform,
      });
    }, 1000);

    const connectResults = await Promise.allSettled(
      platformsToConnect.map(([name, username]) => connectPlatform(name, username).catch((err) => {
        console.error(`Failed to connect ${name}:`, err);
        throw err;
      }))
    );

    const failedConnections = connectResults
      .map((r, i) => r.status === 'rejected' ? platformsToConnect[i][0] : null)
      .filter((name): name is string => Boolean(name));

    let syncSucceeded = false;
    let syncMessage = '';
    let apiResults: any[] | null = null;

    if (failedConnections.length > 0) {
      syncMessage = `Connection failed for: ${failedConnections.join(', ')}. `;
    }

    try {
      const response = await syncAllPlatformsApi();
      const data = response?.data?.data;
      if (data?.results) {
        apiResults = data.results;
        const results = data.results as Array<{ platform: string; success: boolean; error?: string | null }>;
        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success);

        if (failed.length === 0) {
          syncMessage += `All ${succeeded} platform(s) synced successfully`;
          syncSucceeded = failedConnections.length === 0;
        } else if (succeeded > 0) {
          syncMessage += `${succeeded}/${results.length} synced. Failed: ${failed.map((f) => `${f.platform}${f.error ? ` (${f.error})` : ''}`).join(', ')}`;
          syncSucceeded = true; // Partial success
        } else {
          syncMessage += `Sync failed: ${failed.map((f) => `${f.platform}: ${f.error || 'unknown'}`).join('; ')}`;
          syncSucceeded = false;
        }
      } else {
        syncMessage += 'Sync completed';
        syncSucceeded = failedConnections.length === 0;
      }
    } catch (err: any) {
      // Extract per-platform results from error if present (e.g., 502/207 responses)
      const data = err?.response?.data?.data || err?.details?.data || err?.rawData?.data;
      if (data?.results && Array.isArray(data.results)) {
        apiResults = data.results;
        const results = data.results as Array<{ platform: string; success: boolean; error?: string | null }>;
        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success);

        if (succeeded > 0) {
          syncMessage += `${succeeded}/${results.length} synced. Failed: ${failed.map((f) => `${f.platform}${f.error ? ` (${f.error})` : ''}`).join(', ')}`;
          syncSucceeded = true;
        } else {
          syncMessage += `Sync failed: ${failed.map((f) => `${f.platform}: ${f.error || 'unknown'}`).join('; ')}`;
          syncSucceeded = false;
        }
      } else {
        const errMsg = err?.response?.data?.message || err?.message || (err instanceof Error ? err.message : 'Platform sync failed');
        syncMessage += errMsg;
        syncSucceeded = false;
      }
    }

    clearInterval(progressInterval);

    // Reset platform loading flags and attach individual error messages if any
    const currentLc = get().leetcode;
    const currentCf = get().codeforces;
    const currentCc = get().codechef;
    const currentGh = get().github;

    let nextLc = { ...currentLc, loading: false };
    let nextCf = { ...currentCf, loading: false };
    let nextCc = { ...currentCc, loading: false };
    let nextGh = { ...currentGh, loading: false };

    if (failedConnections.includes('leetcode')) nextLc.error = 'Connection failed';
    if (failedConnections.includes('codeforces')) nextCf.error = 'Connection failed';
    if (failedConnections.includes('codechef')) nextCc.error = 'Connection failed';
    if (failedConnections.includes('github')) nextGh.error = 'Connection failed';

    if (apiResults && Array.isArray(apiResults)) {
      for (const r of apiResults) {
        if (r.platform === 'leetcode' && !r.success) {
          nextLc.error = r.error || 'Sync failed';
        } else if (r.platform === 'codeforces' && !r.success) {
          nextCf.error = r.error || 'Sync failed';
        } else if (r.platform === 'codechef' && !r.success) {
          nextCc.error = r.error || 'Sync failed';
        } else if (r.platform === 'github' && !r.success) {
          nextGh.error = r.error || 'Sync failed';
        }
      }
    }

    set({
      syncState: syncSucceeded ? 'success' : 'error',
      syncMessage: syncMessage.trim() || (syncSucceeded ? 'Platform sync completed' : 'Platform sync failed'),
      syncingPlatform: null,
      syncProgressPercent: 100,
      syncTimeRemaining: 0,
      lastSyncedAt: syncSucceeded ? new Date().toISOString() : get().lastSyncedAt,
      leetcode: nextLc,
      codeforces: nextCf,
      codechef: nextCc,
      github: nextGh,
    });

    const { useDashboardStore } = await import('./dashboardStore');
    useDashboardStore.getState().invalidate();

    window.dispatchEvent(new CustomEvent('devtrack:activity-invalidate'));

    if (syncSucceeded) {
      setTimeout(() => {
        if (get().syncState === 'success') {
          set({ syncMessage: null });
        }
      }, 5000);
    }

    return {
      success: syncSucceeded,
      results: apiResults,
      message: syncMessage,
    };
  },
}));

// ---------------------------------------------------------------------------
// MAPPING HELPERS: Dashboard ApiPlatformStats → Profile-specific types
// ---------------------------------------------------------------------------

function mapToLeetCodeStats(p: ApiPlatformStats): LeetCodeStats {
  const contestData = (p.rawData?.userContestRanking as Record<string, unknown>) || {};
  return {
    username: p.username,
    solvedProblem: p.totalSolved,
    easySolved: p.easySolved,
    mediumSolved: p.mediumSolved,
    hardSolved: p.hardSolved,
    totalEasy: 850,
    totalMedium: 1800,
    totalHard: 800,
    acceptanceRate: 0,
    ranking: 0,
    contributionPoints: 0,
    reputation: 0,
    contestRating: typeof p.rating === 'number' ? p.rating : 0,
    contestGlobalRanking: (contestData.globalRanking as number) || 0,
    totalContests: p.totalContests,
    contestTopPercentage: (contestData.topPercentage as number) || 0,
  };
}

function mapToCodeforcesStats(p: ApiPlatformStats): CodeforcesStats {
  return {
    handle: p.username,
    rating: typeof p.rating === 'number' ? p.rating : 0,
    maxRating: typeof p.rating === 'number' ? p.rating : 0,
    rank: p.rank ?? 'unrated',
    maxRank: p.rank ?? 'unrated',
    avatar: '',
    contribution: 0,
    friendOfCount: 0,
    organization: '',
    registrationTimeSeconds: 0,
    totalSolved: p.totalSolved,
    totalContests: p.totalContests,
  };
}

function mapToCodeChefStats(p: ApiPlatformStats): CodeChefStats {
  const raw = p.rawData || {};
  return {
    name: p.username,
    currentRating: typeof p.rating === 'number' ? p.rating : 0,
    highestRating: (raw.highestRating as number) ?? (typeof p.rating === 'number' ? p.rating : 0),
    stars: (raw.stars as string) ?? '0★',
    globalRank: parseInt(String(raw.globalRank || '0'), 10),
    countryRank: parseInt(String(raw.countryRank || '0'), 10),
    countryName: '',
    totalProblemsSolved: (raw.totalSolved as number) || p.totalSolved,
  };
}

function mapToGithubStats(p: ApiPlatformStats): GithubStats {
  const raw = p.rawData || {};
  return {
    username: p.username,
    publicRepos: (raw.public_repos as number) ?? 0,
    followers: (raw.followers as number) ?? 0,
    following: (raw.following as number) ?? 0,
    totalStars: (raw.total_stars as number) ?? 0,
    topLanguages: (raw.top_languages as string[]) ?? [],
    createdAt: (raw.created_at as string) ?? '',
    updatedAt: (raw.updated_at as string) ?? '',
  };
}
