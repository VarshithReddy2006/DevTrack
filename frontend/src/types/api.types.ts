// ============================================================================
// api.types.ts — Raw API Response Types
// ============================================================================
// These types represent the EXACT shape of data returned by the backend API.
// No transformations. No UI concerns. Pure HTTP response contracts.
// ============================================================================

// ---------------------------------------------------------------------------
// 1. COMMON / SHARED API TYPES
// ---------------------------------------------------------------------------

/** Standard envelope for all API responses */
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message: string;
  timestamp: string; // ISO 8601
}

/** Paginated list response */
export interface ApiPaginatedResponse<T> {
  success: boolean;
  data: T[];
  message: string;
  timestamp: string;
  pagination: ApiPagination;
}

export interface ApiPagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/** Normalized API error returned from backend */
export interface ApiError {
  success: false;
  message: string;
  code: string;
  statusCode: number;
  retryAfter?: number | string; // Retry-After seconds or HTTP date
  timestamp: string;
  details?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// 2. USER / AUTH TYPES
// ---------------------------------------------------------------------------

export interface ApiUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  timezone: string;
  joinedAt: string;       // ISO 8601
  lastActiveAt: string;   // ISO 8601
  isEmailVerified: boolean;
  role: 'user' | 'admin';
}

export interface ApiAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
}

export interface ApiLoginResponse {
  user: ApiUser;
  tokens: ApiAuthTokens;
}

export interface ApiRegisterResponse {
  user: ApiUser;
  tokens: ApiAuthTokens;
}

// ---------------------------------------------------------------------------
// 3. DASHBOARD TYPES
// ---------------------------------------------------------------------------

export interface ApiWeeklyXpDay {
  date: string;
  xp: number;
}

export interface ApiDashboardStats {
  totalProblems: number;
  totalSubmissions: number;
  totalActiveDays: number;
  currentStreak: number;
  longestStreak: number;
  totalProjects: number;
  totalCommits: number;
  totalPullRequests: number;
  totalContributions: number;
  weeklyXPHistory?: ApiWeeklyXpDay[];
  weeklyConsistencyScore?: number;
}

export interface ApiStreakData {
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string;       // ISO 8601 date
  streakStartDate: string;      // ISO 8601 date
  isActiveToday: boolean;
  streakHistory: ApiStreakDay[];
}

export interface ApiStreakDay {
  date: string;    // ISO 8601 date
  count: number;   // number of activities
  level: 0 | 1 | 2 | 3 | 4; // contribution intensity
}

export interface ApiPlatformStats {
  platformId: string;
  platformName: 'leetcode' | 'codeforces' | 'github' | 'codechef';
  username: string;
  totalSolved: number;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
  rating: number | null;
  rank: string | null;
  totalContests: number;
  lastSyncedAt: string; // ISO 8601
  profileUrl: string;
  isConnected: boolean;
  rawData?: Record<string, unknown>;
}

export interface ApiMission {
  id: string;
  title: string;
  description: string;
  type: 'daily' | 'weekly' | 'milestone';
  status: 'pending' | 'in_progress' | 'completed' | 'expired';
  targetCount: number;
  currentCount: number;
  xpReward: number;
  category: 'dsa' | 'project' | 'learning' | 'consistency';
  createdAt: string;    // ISO 8601
  expiresAt: string;    // ISO 8601
  completedAt: string | null;
}

export interface ApiDashboardRecentActivity {
  id: string;
  type: 'problem_solved' | 'commit_pushed' | 'pr_merged' | 'project_created' | 'project_updated' | 'project_deleted' | 'contest_participated' | 'streak_milestone' | 'note_added' | 'settings_updated';
  title: string;
  description: string;
  platform: string;
  url: string | null;
  metadata: Record<string, string | number | boolean>;
  occurredAt: string; // ISO 8601
}

export interface ApiGithubDashboardStats {
  repos: number;
  followers: number;
  following: number;
  totalStars: number;
  topLanguages: string[];
  avatarUrl: string | null;
  name: string | null;
  bio: string | null;
  lastSyncedAt: string;
}

export interface ApiDashboardResponse {
  stats: ApiDashboardStats;
  streak: ApiStreakData;
  platformStats: ApiPlatformStats[];
  missions: ApiMission[];
  recentActivity: ApiDashboardRecentActivity[];
  githubStats: ApiGithubDashboardStats | null;
}

// ---------------------------------------------------------------------------
// 5. DSA TRACKER TYPES
// ---------------------------------------------------------------------------

export interface ApiDsaProblem {
  id: string;
  externalId: string;
  title: string;
  platform: 'leetcode' | 'codeforces' | 'codechef' | 'hackerrank' | 'other';
  difficulty: 'easy' | 'medium' | 'hard';
  url: string;
  tags: string[];
  category: string;       // e.g., "Array", "Graph", "DP"
  status: 'unsolved' | 'attempted' | 'solved' | 'revisit';
  notes: string | null;
  timeTaken: number | null;  // seconds
  submissionCount: number;
  lastSubmittedAt: string | null;
  solvedAt: string | null;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiDsaCategory {
  name: string;
  slug: string;
  totalProblems: number;
  solvedCount: number;
  easyCount: number;
  easySolved: number;
  mediumCount: number;
  mediumSolved: number;
  hardCount: number;
  hardSolved: number;
  unknownCount?: number;
  unknownSolved?: number;
}

export interface ApiDsaStats {
  totalProblems: number;
  totalSolved: number;
  totalAttempted: number;
  totalUnsolved: number;
  totalRevisit: number;
  easySolved: number;
  easyTotal: number;
  mediumSolved: number;
  mediumTotal: number;
  hardSolved: number;
  hardTotal: number;
  unknownSolved?: number;
  unknownTotal?: number;
  provenance?: ApiDsaSolveProvenance;
  averageTime: number;       // seconds
  fastestSolve: number;      // seconds
  categories: ApiDsaCategory[];
  weeklyProgress: ApiDsaWeeklyProgress[];
}

export interface ApiDsaWeeklyProgress {
  weekStart: string; // ISO 8601 date
  weekEnd: string;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
  totalSolved: number;
}

export interface ApiDsaListResponse {
  problems: ApiDsaProblem[];
  pagination: ApiPagination;
  stats: ApiDsaStats;
}

export interface ApiDsaSolveProvenance {
  manualSolved: number;
  syncedSolved: number;
  dedupedTotalSolved: number;
}

export interface ApiDsaDashboardResponse {
  solvedByDifficulty?: import('./dsa').DsaDifficultyCounts;
  provenance?: ApiDsaSolveProvenance;
  stats: Array<{ label: string; value: string; icon: string }>;
  heatmap: number[];
  submissions: Array<{
    id: string;
    status: 'accepted' | 'wrong';
    problem: string;
    topic: string;
    platform: string;
    language: string;
    date: string;
    difficulty: 'easy' | 'medium' | 'hard';
  }>;
  contests: Array<{ name: string; platform: string; time: string }>;
  topics: Array<{ name: string; progress: number }>;
  platformOverview: Array<{
    platform: string;
    stat: string;
    totalSolved?: number;
    rank?: string | number | null;
    rating?: number | null;
  }>;
}

export interface ApiDsaFilters {
  difficulty?: 'easy' | 'medium' | 'hard';
  status?: 'unsolved' | 'attempted' | 'solved' | 'revisit';
  category?: string;
  platform?: string;
  tags?: string[];
  isFavorite?: boolean;
  search?: string;
  sortBy?: 'title' | 'difficulty' | 'lastSubmittedAt' | 'solvedAt' | 'timeTaken';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface ApiDsaProblemCreatePayload {
  title: string;
  platform: ApiDsaProblem['platform'];
  difficulty: ApiDsaProblem['difficulty'];
  url: string;
  tags: string[];
  category: string;
  notes?: string;
}

export interface ApiDsaProblemUpdatePayload {
  status?: ApiDsaProblem['status'];
  notes?: string;
  timeTaken?: number;
  isFavorite?: boolean;
  tags?: string[];
}

// DSA Submissions List (GET /api/dsa/submissions)
export interface ApiDsaSubmissionEntry {
  id: string;
  platform: string;
  problemName: string;
  problemDifficulty: string | null;
  problemCategory: string | null;
  status: string;
  language: string;
  executionTime: number | null;
  memoryUsed: number | null;
  submittedAt: string;
}

export interface ApiDsaSubmissionsListResponse {
  submissions: ApiDsaSubmissionEntry[];
  pagination: ApiPagination;
}

// DSA Contests List (GET /api/dsa/contests)
export interface ApiDsaContestEntry {
  id: string;
  platform: string;
  contestName: string;
  rank: number | null;
  totalParticipants: number | null;
  problemsSolved: number;
  ratingBefore: number | null;
  ratingAfter: number | null;
  ratingChange: number | null;
  participatedAt: string;
}

export interface ApiDsaContestsListResponse {
  contests: ApiDsaContestEntry[];
  pagination: ApiPagination;
}

// DSA Topics Analytics (GET /api/dsa/topics)
export interface ApiDsaTopicAnalytics {
  topicName: string;
  totalProblems: number;
  solvedCount: number;
  easyCount: number;
  easySolved: number;
  mediumCount: number;
  mediumSolved: number;
  hardCount: number;
  hardSolved: number;
  unknownCount?: number;
  unknownSolved?: number;
  solveRate: number;
}

export interface ApiDsaTopicsListResponse {
  topics: ApiDsaTopicAnalytics[];
  summary: {
    totalTopics: number;
    totalSolved: number;
    totalProblems: number;
  };
}

// ---------------------------------------------------------------------------
// 6. PROJECTS TYPES
// ---------------------------------------------------------------------------

export interface ApiProject {
  id: string;
  name: string;
  description: string;
  repoUrl: string | null;
  liveUrl: string | null;
  techStack: string[];
  status: 'planning' | 'in_progress' | 'completed' | 'on_hold' | 'archived';
  visibility: 'public' | 'private';
  thumbnailUrl: string | null;
  stars: number;
  forks: number;
  language: string;
  totalCommits: number;
  totalPullRequests: number;
  totalIssues: number;
  openIssues: number;
  lastCommitAt: string | null;
  lastCommitMessage: string | null;
  contributors: ApiProjectContributor[];
  milestones: ApiProjectMilestone[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiProjectContributor {
  id: string;
  username: string;
  avatarUrl: string;
  contributions: number;
}

export interface ApiProjectMilestone {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  dueDate: string | null;
  completedAt: string | null;
  taskCount: number;
  completedTaskCount: number;
}

export interface ApiProjectTask {
  id: string;
  projectId: string;
  milestoneId: string | null;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'critical';
  assigneeId: string | null;
  labels: string[];
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiProjectStats {
  totalProjects: number;
  activeProjects: number;
  completedProjects: number;
  totalCommits: number;
  totalPullRequests: number;
  totalIssues: number;
  languageDistribution: Record<string, number>;
  commitHistory: ApiProjectCommitDay[];
}

export interface ApiProjectCommitDay {
  date: string;
  count: number;
}

export interface ApiProjectListResponse {
  projects: ApiProject[];
  pagination: ApiPagination;
  stats: ApiProjectStats;
}

export interface ApiProjectFilters {
  status?: ApiProject['status'];
  visibility?: ApiProject['visibility'];
  language?: string;
  search?: string;
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'stars' | 'lastCommitAt';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface ApiProjectCreatePayload {
  name: string;
  description: string;
  repoUrl?: string;
  liveUrl?: string;
  techStack: string[];
  status: ApiProject['status'];
  visibility: ApiProject['visibility'];
}

export interface ApiProjectUpdatePayload {
  name?: string;
  description?: string;
  repoUrl?: string;
  liveUrl?: string;
  techStack?: string[];
  status?: ApiProject['status'];
  visibility?: ApiProject['visibility'];
}

// ---------------------------------------------------------------------------
// 7. SETTINGS TYPES
// ---------------------------------------------------------------------------

export interface ApiUserProfile {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  timezone: string;
  joinedAt: string;
  lastActiveAt: string;
  socialLinks: ApiSocialLinks;
  location?: string | null;
  roleTitle?: string | null;
  targetRole?: string | null;
  targetCompanies?: string[];
  techStack?: string[];
}

export interface ApiSocialLinks {
  github: string | null;
  linkedin: string | null;
  twitter: string | null;
  portfolio: string | null;
  leetcode: string | null;
  codeforces: string | null;
  codechef: string | null;
}

export interface ApiConnectedPlatform {
  id: string;
  platformName: string;
  username: string;
  profileUrl: string;
  isConnected: boolean;
  lastSyncedAt: string | null;
  syncStatus: 'idle' | 'syncing' | 'error' | 'success';
  syncError: string | null;
}

export interface ApiNotificationPreferences {
  emailNotifications: boolean;
  pushNotifications: boolean;
  dailyDigest: boolean;
  weeklyReport: boolean;
  streakReminder: boolean;
  missionAlerts: boolean;
  projectUpdates: boolean;
}

export interface ApiAppearanceSettings {
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  compactMode: boolean;
  showHeatmap: boolean;
  heatmapColor: string;
  language: string;
}

export interface ApiPrivacySettings {
  profileVisibility: 'public' | 'private' | 'friends_only';
  showActivity: boolean;
  showStreak: boolean;
  showProjects: boolean;
  showDsaProgress: boolean;
}

export interface ApiSettingsResponse {
  profile: ApiUserProfile;
  connectedPlatforms: ApiConnectedPlatform[];
  notifications: ApiNotificationPreferences;
  appearance: ApiAppearanceSettings;
  privacy: ApiPrivacySettings;
}

export interface ApiProfileUpdatePayload {
  displayName?: string;
  bio?: string;
  timezone?: string;
  location?: string | null;
  roleTitle?: string | null;
  targetRole?: string | null;
  targetCompanies?: string[];
  techStack?: string[];
  socialLinks?: Partial<ApiSocialLinks>;
}

export interface ApiPasswordChangePayload {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface ApiPlatformConnectPayload {
  platformName: string;
  username: string;
  accessToken?: string;
}

 
export interface ApiNotificationUpdatePayload extends Partial<ApiNotificationPreferences> { }

 
export interface ApiAppearanceUpdatePayload extends Partial<ApiAppearanceSettings> { }

 
export interface ApiPrivacyUpdatePayload extends Partial<ApiPrivacySettings> { }

// ---------------------------------------------------------------------------
// 8. GENERIC MUTATION RESPONSE
// ---------------------------------------------------------------------------

export interface ApiMutationResponse {
  success: boolean;
  message: string;
  timestamp: string;
}

export interface ApiDeleteResponse {
  success: boolean;
  message: string;
  deletedId: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// 9. PROFILE PLATFORM STATS (from backend sync)
// ---------------------------------------------------------------------------

/** Individual platform stats item returned by GET /profile/platforms/stats */
export interface ApiPlatformStatsItem {
  platformName: string;
  username: string;
  totalSolved: number;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
  rating: number | null;
  rank: string | null;
  totalContests: number;
  fetchedAt: string; // ISO 8601
}

/** Full response from GET /profile/platforms/stats */
export interface ApiPlatformStatsResponse {
  platforms: ApiPlatformStatsItem[];
  totals: {
    totalSolvedAllPlatforms: number;
  };
}

// ---------------------------------------------------------------------------
// 10. ACHIEVEMENTS TYPES
// ---------------------------------------------------------------------------

export interface ApiAchievement {
  id: string;
  icon: string;
  title: string;
  description: string;
  unlockedAt: string | null;
  progress: number;
  target: number;
  isUnlocked: boolean;
  category: 'streak' | 'problems' | 'contest' | 'projects' | 'social';
  xpReward: number;
}

export interface ApiAchievementsResponse {
  achievements: ApiAchievement[];
  totalUnlocked: number;
  totalAchievements: number;
  totalXp: number;
}

