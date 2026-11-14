// src/db/models/index.ts - Models barrel export
export { User, type IUser } from './user.model.js';
export * from './betaUser.model.js';
export * from './betaCohort.model.js';

// Readiness & Intelligence Models
export * from './careerIntent.model.js';
export * from './readinessCore.model.js';
export * from './readinessDsa.model.js';
export * from './readinessSkills.model.js';
export * from './readinessProjects.model.js';
export * from './readinessRoadmap.model.js';
export * from './readinessBenchmarks.model.js';
export { IntelligenceRecommendation, type IIntelligenceRecommendation, type RecommendationCategory, type RecommendationState } from './intelligenceRecommendation.model.js';
export * from './datasetIngestion.model.js';

export { UserProfile, type IUserProfile } from './userProfile.model.js';
export { UserSettings, type IUserSettings } from './userSettings.model.js';
export { ConnectedPlatform, type IConnectedPlatform } from './connectedPlatform.model.js';
export { PlatformStats, type IPlatformStats } from './platformStats.model.js';
export { ActivityEvent, type IActivityEvent } from './activityEvent.model.js';
export { DailyActivity, type IDailyActivity } from './dailyActivity.model.js';
export { DsaProblem, type IDsaProblem } from './dsaProblem.model.js';
export { DsaTopicProgress, type IDsaTopicProgress } from './dsaTopicProgress.model.js';
export { DsaSubmission, type IDsaSubmission } from './dsaSubmission.model.js';
export { DsaContest, type IDsaContest } from './dsaContest.model.js';
export { Project, type IProject, type IProjectContributor, type IProjectMilestone } from './project.model.js';
export { ProjectTask, type IProjectTask } from './projectTask.model.js';
export { Mission, type IMission } from './mission.model.js';
export { SyncJob, type ISyncJob } from './syncJob.model.js';
export { UserXp, type IUserXp } from './userXp.model.js';
export { XpTransaction, type IXpTransaction, type XpSourceType } from './xpTransaction.model.js';
export { UserStreakLog, type IUserStreakLog, type StreakType } from './userStreakLog.model.js';
export { UserAnalytics, type IUserAnalytics } from './userAnalytics.model.js';
export { ProcessedEvent, type IProcessedEvent } from './processedEvent.model.js';
export { DailyChallenge, type IDailyChallenge } from './dailyChallenge.model.js';
export { UserDailyChallenge, type IUserDailyChallenge } from './userDailyChallenge.model.js';

// Phase-I Validation Models
// Removed

// Phase-J Beta Models
// Removed

// Retention module models (imported directly from modules)
// Removed

export { UnifiedRuntimeState, type IUnifiedRuntimeState, type MomentumState, type FatigueState, type EmotionalState, type RecoveryState, type OnboardingStage, type EngagementPressure, type ActiveGoalRef, type ActiveChallengeRef, type ActiveAchievementRef, type NearMilestoneRef, type ProgressionPacing } from './unifiedRuntimeState.model.js';
export { FocusSession, type IFocusSession } from './focusSession.model.js';

// Verified Proof-of-Work Models
export { PublicProfile, type IPublicProfile } from './publicProfile.model.js';
export { VerifiedProject, type IVerifiedProject } from './verifiedProject.model.js';
export { ProfileAuditLog, type IProfileAuditLog } from './profileAuditLog.model.js';
export { ProfileView, type IProfileView } from './profileView.model.js';
export { ProfileTimelineEvent, type IProfileTimelineEvent } from './profileTimelineEvent.model.js';
export { AIConversation, type IAIConversation, type IConversationTurn } from './aiConversation.model.js';
export { FeedbackReportModel, type IFeedbackReport } from './feedbackReport.model.js';
