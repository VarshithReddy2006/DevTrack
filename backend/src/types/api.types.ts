// src/types/api.types.ts - API type definitions (mirrors frontend types)
import type { DsaProblemPlatform } from '../shared/dsa-platforms.js';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message: string;
  timestamp: string;
}

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

export interface ApiError {
  success: false;
  message: string;
  code: string;
  statusCode: number;
  timestamp: string;
  details?: Record<string, string[]>;
}

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

// User / Auth Types
export interface ApiUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  timezone: string;
  joinedAt: string;
  lastActiveAt: string;
  isEmailVerified: boolean;
  role: 'user' | 'admin';
}

export interface ApiAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface ApiLoginResponse {
  user: ApiUser;
  tokens: ApiAuthTokens;
}

export interface ApiRegisterResponse {
  user: ApiUser;
  tokens: ApiAuthTokens;
}

// Dashboard Types
export interface ApiWeeklyXpDay {
  date: string;   // ISO date string "YYYY-MM-DD"
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
  weeklyXPHistory: ApiWeeklyXpDay[];   // last 7 days, Mon–Sun
  weeklyConsistencyScore: number;      // 0–100
}

export interface ApiStreakData {
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string;
  streakStartDate: string;
  isActiveToday: boolean;
  streakHistory: ApiStreakDay[];
}

export interface ApiStreakDay {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
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
  lastSyncedAt: string;
  profileUrl: string;
  isConnected: boolean;
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
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
}

export interface ApiDashboardRecentActivity {
  id: string;
  type: 'problem_solved' | 'commit_pushed' | 'pr_merged' | 'project_created' | 'project_updated' | 'project_deleted' | 'contest_participated' | 'streak_milestone';
  title: string;
  description: string;
  platform: string;
  url: string | null;
  metadata: Record<string, string | number | boolean>;
  occurredAt: string;
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

// Activity Types
export interface ApiActivityDay {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  activities: ApiActivityEntry[];
}

export interface ApiActivityEntry {
  id: string;
  type: 'problem_solved' | 'commit_pushed' | 'pr_merged' | 'project_created' | 'project_updated' | 'project_deleted' | 'contest_participated' | 'contest_joined' | 'streak_milestone' | 'note_added' | 'settings_updated' | 'github_sync_completed' | 'focus_session';
  title: string;
  description: string;
  platform: string;
  url: string | null;
  tags: string[];
  metadata: Record<string, string | number | boolean>;
  occurredAt: string;
}

export interface ApiActivitySummary {
  totalActivities: number;
  totalActiveDays: number;
  currentStreak: number;
  longestStreak: number;
  mostActiveDay: string;
  avgPerDay: number;
  byPlatform: Record<string, number>;
  byType: Record<string, number>;
}

export interface ApiActivityHeatmapResponse {
  year: number;
  days: ApiActivityDay[];
  summary: ApiActivitySummary;
}

export interface ApiActivityFeedResponse {
  activities: ApiActivityEntry[];
  pagination: ApiPagination;
}

export interface ApiActivityFilters {
  startDate?: string;
  endDate?: string;
  platform?: string;
  type?: string;
  tags?: string[];
  page?: number;
  pageSize?: number;
}

// DSA Types
export interface ApiDsaProblem {
  id: string;
  externalId: string;
  title: string;
  platform: DsaProblemPlatform;
  difficulty: 'easy' | 'medium' | 'hard';
  url: string;
  tags: string[];
  category: string;
  status: 'unsolved' | 'attempted' | 'solved' | 'revisit';
  notes: string | null;
  timeTaken: number | null;
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
  unknownCount: number;
  unknownSolved: number;
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
  unknownSolved: number;
  unknownTotal: number;
  provenance: ApiDsaSolveProvenance;
  averageTime: number;
  fastestSolve: number;
  categories: ApiDsaCategory[];
  weeklyProgress: ApiDsaWeeklyProgress[];
}

export interface ApiDsaWeeklyProgress {
  weekStart: string;
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

export interface ApiDsaSummaryItem {
  label: string;
  value: string;
  icon: string;
}

export interface ApiDsaDashboardSubmission {
  id: string;
  status: 'accepted' | 'wrong';
  problem: string;
  topic: string;
  platform: string;
  language: string;
  date: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface ApiDsaContest {
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

export interface ApiDsaTopic {
  name: string;
  progress: number;
}

// Detailed topic analytics (for /api/dsa/topics endpoint)
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
  unknownCount: number;
  unknownSolved: number;
  solveRate: number; // 0-100
}

// Submissions list response (for /api/dsa/submissions endpoint)
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

export interface ApiDsaContestsListResponse {
  contests: ApiDsaContest[];
  pagination: ApiPagination;
}

export interface ApiDsaTopicsListResponse {
  topics: ApiDsaTopicAnalytics[];
  summary: {
    totalTopics: number;
    totalSolved: number;
    totalProblems: number;
  };
}

export interface ApiDsaPlatformOverviewItem {
  platform: string;
  stat: string;
  totalSolved: number;
  rating: number | null;
  rank: string | null;
}

export interface ApiDsaSolveProvenance {
  manualSolved: number;
  syncedSolved: number;
  dedupedTotalSolved: number;
}

export interface ApiDsaDashboardResponse {
  stats: ApiDsaSummaryItem[];
  solvedByDifficulty: Record<'easy' | 'medium' | 'hard' | 'unknown', number>;
  provenance: ApiDsaSolveProvenance;
  heatmap: number[];
  submissions: ApiDsaDashboardSubmission[];
  contests: ApiDsaContest[];
  topics: ApiDsaTopic[];
  platformOverview: ApiDsaPlatformOverviewItem[];
}

// Heatmap response (Phase 7: generated from DsaSubmission)
export interface ApiDsaHeatmapEntry {
  date: string;
  count: number;
}

export interface ApiDsaHeatmapResponse {
  heatmap: ApiDsaHeatmapEntry[];
  totalSubmissions: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
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

// Project Types
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
  rank: string | null;
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

// Settings Types
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
  roleTitle: string | null;
  location: string | null;
  targetRole: string | null;
  targetCompanies: string[];
  techStack: string[];
  socialLinks: ApiSocialLinks;
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
  roleTitle?: string | null;
  location?: string | null;
  techStack?: string[];
  targetRole?: string | null;
  targetCompanies?: string[];
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
  fetchedAt: string;
}

export interface ApiPlatformStatsResponse {
  platforms: ApiPlatformStatsItem[];
  totals: {
    totalSolvedAllPlatforms: number;
  };
}

// Achievement Types
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
