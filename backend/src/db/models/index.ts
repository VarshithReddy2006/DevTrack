// src/db/models/index.ts - Models barrel export
export { User, type IUser } from './user.model.js';
export * from './betaUser.model.js';
export * from './betaCohort.model.js';

// Readiness & Intelligence Models
export * from './careerIntent.model.js';
export * from './careerRoadmap.model.js';
export { NotificationRecord, NotificationPreference } from './notification.model.js';
export * from './readinessCore.model.js';
export * from './readinessDsa.model.js';
export * from './readinessSkills.model.js';
export * from './readinessProjects.model.js';
export * from './readinessRoadmap.model.js';
export * from './readinessBenchmarks.model.js';
export * from './readinessInput.model.js';
export { IntelligenceRecommendation, type IIntelligenceRecommendation, type RecommendationCategory, type RecommendationState } from './intelligenceRecommendation.model.js';
export * from './datasetIngestion.model.js';

export { UserProfile, type IUserProfile } from './userProfile.model.js';
export { UserSettings, type IUserSettings } from './userSettings.model.js';
export { ConnectedPlatform, type IConnectedPlatform } from './connectedPlatform.model.js';
export { PlatformStats, type IPlatformStats } from './platformStats.model.js';
export { ActivityEvent, type IActivityEvent } from './activityEvent.model.js';
export { DailyActivity, type IDailyActivity } from './dailyActivity.model.js';
export { DsaProblem, type IDsaProblem } from './dsaProblem.model.js';
export { DSAProfile, DSAProfile as DsaProfile, type IDSAProfile } from './dsaProfile.model.js';
export { DsaTopicProgress, type IDsaTopicProgress } from './dsaTopicProgress.model.js';
export { DsaSubmission, type IDsaSubmission } from './dsaSubmission.model.js';
export { DsaSubmissionArchive, type IDsaSubmissionArchive } from './dsaSubmissionArchive.model.js';
export { DsaContest, type IDsaContest } from './dsaContest.model.js';
export { DsaContestParticipation } from './dsaContestParticipation.model.js';
export { Project, type IProject, type IProjectContributor, type IProjectMilestone } from './project.model.js';
export { ProjectTask, type IProjectTask } from './projectTask.model.js';
export { Mission, type IMission } from './mission.model.js';
export { SyncJob, type ISyncJob } from './syncJob.model.js';
export { UserXp, type IUserXp } from './userXp.model.js';
export { XpTransaction, type IXpTransaction, type XpSourceType } from './xpTransaction.model.js';
export { LeagueStanding, LEAGUE_DIVISIONS, type ILeagueStanding, type LeagueDivision, type LeagueOutcome, type LeagueStandingStatus } from './leagueStanding.model.js';
export { LeagueCohort, type ILeagueCohort } from './leagueCohort.model.js';
export {
  LeagueRolloverLog,
  SAGA_COHORT_STATUSES,
  SAGA_COHORT_STEPS,
  type ILeagueRolloverLog,
  type SagaCohortStatus,
  type SagaCohortStep,
  type ILeagueRolloverSnapshotMember,
  type ILeagueRolloverPreviousStanding,
  type ILeagueRolloverNextWeekPlacement,
  type ILeagueRolloverRollbackRecord,
  type ILeagueRolloverError,
} from './leagueRolloverLog.model.js';
export { RenderArtifact, RENDER_ARTIFACT_TYPES, RENDER_ARTIFACT_STATUSES, type IRenderArtifact, type RenderArtifactType, type RenderArtifactStatus } from './renderArtifact.model.js';
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
export { UsernameReservation, type IUsernameReservation } from './usernameReservation.model.js';
export { CustomDomain, CUSTOM_DOMAIN_STATUSES, type ICustomDomain, type CustomDomainStatus } from './customDomain.model.js';
export { VerifiedProject, type IVerifiedProject } from './verifiedProject.model.js';
export {
  ProfileAuditLog,
  AuditEncryptionKey,
  type IProfileAuditLog,
  type IAuditEncryptionKey,
  type ProfileAuditEventType,
} from './profileAuditLog.model.js';
export { AuditCheckpoint, type IAuditCheckpoint } from './auditCheckpoint.model.js';
export { AntiGamingDecision, type IAntiGamingDecision } from './antiGamingDecision.model.js';
export { ProfileView, type IProfileView } from './profileView.model.js';
export { ProfileTimelineEvent, type IProfileTimelineEvent } from './profileTimelineEvent.model.js';
export { AIConversation, type IAIConversation, type IConversationTurn } from './aiConversation.model.js';
export { FeedbackReportModel, type IFeedbackReport } from './feedbackReport.model.js';
export { FeatureFlag, type IFeatureFlag } from './featureFlag.model.js';
export { FeatureFlagAudit, type IFeatureFlagAudit, type FeatureFlagChange } from './featureFlagAudit.model.js';
export { RevisionCard, type IRevisionCard, type ProblemDifficulty } from './revisionCard.model.js';
export { ResumeProfile, type IResumeProfile } from './resumeProfile.model.js';
export { ResumeVersion, type IResumeVersion } from './resumeVersion.model.js';
export { ResumeBulletRevision, type IResumeBulletRevision } from './resumeBulletRevision.model.js';
export { ResumeExport, type IResumeExport } from './resumeExport.model.js';
export { ResumeEvidenceClaim, type IResumeEvidenceClaim } from './resumeEvidenceClaim.model.js';
export { ResumeSession, type IResumeSession } from './resumeSession.model.js';
export { ResumeVariant, type IResumeVariant } from './resumeVariant.model.js';
export { ResumeCredibility, type IResumeCredibility } from './resumeCredibility.model.js';
export { JobTarget, type IJobTarget, type JobTargetStatus } from './jobTarget.model.js';
export { InterviewReport } from './interviewReport.model.js';
export { UserQuestProgress, type IUserQuestProgress } from './userQuestProgress.model.js';
export { VerifiedClaimProof, type IVerifiedClaimProof, type IZkpProofPayload, type IZkpPublicSignals } from './verifiedClaimProof.model.js';
