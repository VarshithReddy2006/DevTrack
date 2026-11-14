import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSessionState } from '../state/useSessionState';
import { ResumeProcessingOrchestrator } from '../orchestration/ResumeProcessingOrchestrator';
import { GuidedIntelligenceProvider } from '../context/GuidedIntelligenceMode';
import { AnalysisHeader } from '../sections/AnalysisHeader';
import { SectionNavigation } from '../sections/SectionNavigation';
import { SectionCanvas } from '../sections/SectionCanvas';
import { DiagnosticsDrawer } from '../sections/DiagnosticsDrawer';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import api from '../../../utils/axiosClient.js';
import { analyticsService } from '../../../services/analyticsService';

export const ResumeAnalysisWorkspace: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState('overview');
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [hasAttemptedReportGen, setHasAttemptedReportGen] = useState<string | null>(null);
  const { currentSession, fetchSession, isLoading, error } = useSessionState();

  useEffect(() => {
    if (sessionId && (!currentSession || currentSession.sessionId !== sessionId)) {
      fetchSession(sessionId);
    }
  }, [sessionId]);

  // Auto-generate report if reportData is missing
  useEffect(() => {
    if (
      currentSession &&
      !currentSession.reportData &&
      !isGeneratingReport &&
      currentSession.status === 'completed' &&
      hasAttemptedReportGen !== currentSession.sessionId
    ) {
      const generateReport = async () => {
        try {
          setIsGeneratingReport(true);
          setHasAttemptedReportGen(currentSession.sessionId);
          const res = await api.post('/resume-intelligence/report', {
            sessionId: currentSession.sessionId,
          });
          // The API may return the shape directly or wrapped in `data`
          const success = (res as any).success ?? (res as any).data?.success;
          if (success) {
            analyticsService.trackEvent('resume_analysis_completed', { sessionId: currentSession.sessionId });
            // Re-fetch session to get the report data
            fetchSession(currentSession.sessionId);
          } else {
            console.error('Report generation failed:', res);
          }
        } catch (err) {
          console.error('Failed to auto-generate report:', err);
        } finally {
          setIsGeneratingReport(false);
        }
      };
      generateReport();
    }
  }, [currentSession?.sessionId, currentSession?.reportData, currentSession?.status, hasAttemptedReportGen]);

  if (isLoading) {
    return (
      <div className="w-full min-h-[calc(100vh-64px)] bg-[#FAFAFC] flex flex-col items-center justify-center p-6">
        <Loader2 className="w-8 h-8 text-dt-primary animate-spin mb-4" />
        <h2 className="text-[15px] font-semibold text-dt-text">Loading analysis...</h2>
        <p className="text-[13px] text-dt-textMuted mt-1 font-medium">Restoring session data</p>
      </div>
    );
  }

  if (error || (!sessionId && !currentSession)) {
    return (
      <div className="w-full min-h-[calc(100vh-64px)] bg-[#FAFAFC] flex flex-col items-center justify-center p-6">
        <AlertCircle className="w-8 h-8 text-rose-500 mb-4" />
        <h2 className="text-[15px] font-semibold text-dt-text">{error || 'No active session found.'}</h2>
        <button
          onClick={() => navigate('/resume')}
          className="dt-btn dt-btn-primary dt-btn-md mt-5"
        >
          Return to Upload
        </button>
      </div>
    );
  }

  if (!currentSession) return null;

  // Report is still loading/generating
  const hasReport = !!currentSession.reportData;

  return (
    <GuidedIntelligenceProvider>
      <ResumeProcessingOrchestrator>
        <div className="w-full min-h-[calc(100vh-64px)] bg-[#FAFAFC] text-dt-text">
          
          {/* Ambient background */}
          <div className="fixed inset-0 bg-[linear-gradient(to_right,#8B5CF60A_1px,transparent_1px),linear-gradient(to_bottom,#8B5CF60A_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none z-0" />
          <div className="fixed -top-40 -right-40 w-[500px] h-[500px] bg-violet-500/[0.03] rounded-full blur-[100px] pointer-events-none z-0" />

          <div className="relative z-10 w-full max-w-[960px] mx-auto px-6 lg:px-10 py-8 lg:py-10 flex flex-col gap-6">
            
            {/* Header */}
            <AnalysisHeader onOpenDiagnostics={() => setIsDiagnosticsOpen(true)} />

            {/* Navigation */}
            <SectionNavigation
              activeSection={activeSection}
              onSectionSelect={setActiveSection}
            />

            {/* Active Section or loading state */}
            <div className="pt-2">
              {hasReport || activeSection === 'replay' ? (
                <SectionCanvas activeSection={activeSection} />
              ) : (
                <div className="flex flex-col items-center justify-center py-20 gap-4">
                  {isGeneratingReport ? (
                    <>
                      <Loader2 className="w-8 h-8 text-dt-primary animate-spin" />
                      <p className="text-[14px] font-semibold text-dt-text">Generating intelligence report...</p>
                      <p className="text-[13px] text-dt-textMuted font-medium">This may take a moment</p>
                    </>
                  ) : currentSession.status === 'failed' ? (
                    <>
                      <AlertCircle className="w-8 h-8 text-rose-500" />
                      <p className="text-[14px] font-semibold text-dt-text">Processing Failed</p>
                      <p className="text-[13px] text-dt-textMuted font-medium">
                        The analysis pipeline encountered an error during execution.
                      </p>
                      <button
                        onClick={() => navigate('/resume')}
                        className="dt-btn dt-btn-primary dt-btn-md flex items-center gap-2 mt-2"
                      >
                        <RefreshCw className="w-4 h-4" />
                        Return to Upload
                      </button>
                    </>
                  ) : currentSession.status !== 'completed' ? (
                    <>
                      <Loader2 className="w-8 h-8 text-dt-primary animate-spin" />
                      <p className="text-[14px] font-semibold text-dt-text">Analysis in progress...</p>
                      <p className="text-[13px] text-dt-textMuted font-medium capitalize">
                        Current stage: {currentSession.status}
                      </p>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-8 h-8 text-amber-500" />
                      <p className="text-[14px] font-semibold text-dt-text">Report not yet generated</p>
                      <button
                        onClick={async () => {
                          try {
                            setIsGeneratingReport(true);
                            const res = await api.post('/resume-intelligence/report', {
                              sessionId: currentSession.sessionId
                            });
                            if (res.data?.success) {
                              fetchSession(currentSession.sessionId);
                            }
                          } catch (err) {
                            console.error(err);
                          } finally {
                            setIsGeneratingReport(false);
                          }
                        }}
                        className="dt-btn dt-btn-primary dt-btn-md flex items-center gap-2"
                      >
                        <RefreshCw className="w-4 h-4" />
                        Generate Report
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Diagnostics Drawer */}
          <DiagnosticsDrawer
            isOpen={isDiagnosticsOpen}
            onClose={() => setIsDiagnosticsOpen(false)}
          />
        </div>
      </ResumeProcessingOrchestrator>
    </GuidedIntelligenceProvider>
  );
};
