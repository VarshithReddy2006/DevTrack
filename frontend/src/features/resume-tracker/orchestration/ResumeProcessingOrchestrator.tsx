import React, { type ReactNode } from 'react';
import { useSessionState } from '../state/useSessionState';
import { useUploadState } from '../state/useUploadState';
import { useSse } from '../../../hooks/useSse';

const STAGE_MAP: Record<string, any> = {
  UPLOADED: { stage: 'uploading', stageResult: 'upload' },
  VALIDATING: { stage: 'validating', stageResult: 'upload' },
  PARSING: { stage: 'parsing', stageResult: 'ats' },
  EXTRACTING: { stage: 'extracting', stageResult: 'ats' },
  ATS_ANALYZING: { stage: 'analyzing', stageResult: 'ats' },
  EMBEDDING: { stage: 'analyzing', stageResult: 'intelligence' },
  SEMANTIC_ANALYZING: { stage: 'analyzing', stageResult: 'intelligence' },
  RECOMMENDING: { stage: 'analyzing', stageResult: 'recommendations' },
  REPLAY_GENERATING: { stage: 'analyzing', stageResult: 'recommendations' },
  REPORT_GENERATING: { stage: 'analyzing', stageResult: 'recommendations' },
  COMPLETED: { stage: 'completed', stageResult: 'recommendations' },
  DEGRADED: { stage: 'completed', stageResult: 'recommendations' },
  FAILED: { stage: 'failed', stageResult: 'recommendations' },
};

export const ResumeProcessingOrchestrator: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { currentSession, updateStage, updateStageResult, fetchSession } = useSessionState();
  const { setProgress } = useUploadState();

  useSse({
    onEvent: (e) => {
      if (currentSession && e.type === 'resume_progression' && e.payload?.sessionId === currentSession.sessionId) {
        const { stage, internalStage, status, progress } = e.payload;
        
        const lookupStage = internalStage || stage;
        const mapped = STAGE_MAP[lookupStage];
        if (mapped) {
          const failed = status === 'failed' || lookupStage === 'FAILED';
          updateStage(failed ? 'failed' : mapped.stage);
          
          const stageStatus = failed ? 'failed' :
            status === 'completed' || status === 'degraded' || lookupStage === 'COMPLETED' || lookupStage === 'DEGRADED'
              ? 'success' : 'processing';
          
          if (mapped.stageResult === 'ats' && lookupStage !== 'ATS_ANALYZING' && !failed) {
            updateStageResult('ats', 'processing');
          } else {
            updateStageResult(mapped.stageResult, stageStatus, e.payload.errors?.[0]);
          }

          if (failed || lookupStage === 'COMPLETED' || lookupStage === 'DEGRADED' ||
              (lookupStage === 'ATS_ANALYZING' && stageStatus === 'success') ||
              (lookupStage === 'SEMANTIC_ANALYZING' && stageStatus === 'success')) {
            void fetchSession(currentSession.sessionId, true);
          }
          
          if (progress !== undefined) {
            setProgress(progress);
          }
        }
      }
    }
  });

  return <>{children}</>;
};
