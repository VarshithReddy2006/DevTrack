import { create } from 'zustand';
import type { ResumeSession, ProcessingStage } from '../types/resumeContracts';
import { resumeUploadService } from '../../../services/resumeUploadService';

interface SessionState {
  currentSession: ResumeSession | null;
  activeStage: ProcessingStage;
  isLoading: boolean;
  error: string | null;
  startSession: (fileInfo: ResumeSession['fileInfo']) => void;
  fetchSession: (sessionId: string, background?: boolean) => Promise<void>;
  updateStage: (stage: ProcessingStage) => void;
  updateStageResult: (stageName: keyof ResumeSession['stages'], status: ResumeSession['stages'][keyof ResumeSession['stages']]['status'], error?: string) => void;
  resetSession: () => void;
}

const mapBackendToFrontendStage = (backendStage: string): ProcessingStage => {
  switch (backendStage) {
    case 'UPLOADED': return 'uploading';
    case 'VALIDATING': return 'validating';
    case 'PARSING': return 'parsing';
    case 'EXTRACTING': return 'extracting';
    case 'ATS_ANALYZING': return 'analyzing';
    case 'EMBEDDING': return 'analyzing';
    case 'SEMANTIC_ANALYZING': return 'analyzing';
    case 'RECOMMENDING': return 'analyzing';
    case 'REPLAY_GENERATING': return 'analyzing';
    case 'REPORT_GENERATING': return 'analyzing';
    case 'COMPLETED': return 'completed';
    case 'FAILED': return 'failed';
    case 'DEGRADED': return 'completed';
    default: return 'analyzing';
  }
};

let latestFetch = 0;

export const useSessionState = create<SessionState>((set, get) => ({
  currentSession: null,
  activeStage: 'uploading',
  isLoading: false,
  error: null,

  startSession: (fileInfo) => set({
    activeStage: 'uploading',
    currentSession: {
      sessionId: crypto.randomUUID(),
      userId: 'current-user', // would come from auth
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'uploading',
      fileInfo,
      stages: {
        upload: { status: 'processing', startedAt: new Date().toISOString() },
        ats: { status: 'pending' },
        intelligence: { status: 'pending' },
        credibility: { status: 'pending' },
        recommendations: { status: 'pending' },
      }
    }
  }),

  fetchSession: async (sessionId: string, background = false) => {
    if (background && (get().isLoading || get().currentSession?.sessionId !== sessionId)) return;
    const request = ++latestFetch;
    if (!background) set({ isLoading: true, error: null });
    try {
      const { data: session } = await resumeUploadService.getSession(sessionId);
      
      if (!session) {
        throw new Error('Session not found');
      }

      const atsHistory = session.processingHistory.filter((entry: { stage: string }) =>
        entry.stage === 'ATS_ANALYZING').at(-1);
      const atsFailed = session.currentStage === 'FAILED' && !session.atsState.analyzed;
      const atsProcessing = ['PARSING', 'EXTRACTING', 'ATS_ANALYZING'].includes(session.currentStage);

      const frontendSession: ResumeSession = {
        sessionId: session.sessionId,
        userId: session.userId || 'unknown',
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: mapBackendToFrontendStage(session.currentStage),
        fileInfo: {
          fileName: session.uploadMetadata.originalFilename,
          fileSize: session.uploadMetadata.fileSize,
          mimeType: session.uploadMetadata.mimeType,
        },
        stages: {
          upload: { 
            status: session.processingHistory.find((h: any) => h.stage === 'UPLOADED')?.status || 'success',
            startedAt: session.processingHistory.find((h: any) => h.stage === 'UPLOADED')?.startedAt,
            completedAt: session.processingHistory.find((h: any) => h.stage === 'UPLOADED')?.completedAt,
          },
          ats: {
            status: atsFailed ? 'failed' : session.atsState.analyzed ? 'success' :
                    atsProcessing ? 'processing' : 'pending',
            startedAt: atsHistory?.startedAt,
            completedAt: session.atsState.analyzedAt ?? (atsFailed ? session.failureState?.failedAt : undefined),
            error: atsFailed ? session.failureState?.failureReason ?? atsHistory?.error : undefined,
          },
          intelligence: {
            status: session.embeddingState.generated && session.semanticState.analyzed ? 'success' :
                   (['EMBEDDING', 'SEMANTIC_ANALYZING'].includes(session.currentStage) ? 'processing' : 'pending'),
            completedAt: session.semanticState.analyzedAt,
          },
          credibility: {
            status: session.recommendationState.generated ? 'success' :
                   (session.currentStage === 'RECOMMENDING' ? 'processing' : 'pending'),
            completedAt: session.recommendationState.generatedAt,
          },
          recommendations: {
            status: session.recommendationState.generated ? 'success' :
                   (session.currentStage === 'RECOMMENDING' ? 'processing' : 'pending'),
            completedAt: session.recommendationState.generatedAt,
          }
        },
        canResume: session.currentStage === 'FAILED' && Boolean(session.failureState?.failed && session.checkpointState?.stage),
        atsState: session.atsState,
        parsedContent: session.parsedContent,
        semanticState: session.semanticState,
        recommendationState: session.recommendationState,
        reportData: session.reportState?.reportData
      };

      if (request !== latestFetch || (background && get().currentSession?.sessionId !== sessionId)) return;
      set({
        currentSession: frontendSession, 
        activeStage: frontendSession.status,
        isLoading: false 
      });
    } catch (err: any) {
      if (!background && request === latestFetch) {
        set({ error: err.message || 'Failed to fetch session', isLoading: false });
      }
    }
  },

  updateStage: (stage) => set((state) => ({
    activeStage: stage,
    currentSession: state.currentSession ? { ...state.currentSession, status: stage, updatedAt: new Date().toISOString() } : null
  })),

  updateStageResult: (stageName, status, error) => set((state) => {
    if (!state.currentSession) return state;
    return {
      currentSession: {
        ...state.currentSession,
        updatedAt: new Date().toISOString(),
        stages: {
          ...state.currentSession.stages,
          [stageName]: {
            ...state.currentSession.stages[stageName],
            status,
            error,
            ...(status === 'success' || status === 'failed' ? { completedAt: new Date().toISOString() } : {}),
            ...(status === 'processing' ? { startedAt: new Date().toISOString() } : {})
          }
        }
      }
    };
  }),

  resetSession: () => set({ currentSession: null, activeStage: 'uploading' })
}));
