import React, { useEffect, useRef, useState } from 'react';
import { motion as framerMotion } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import { useRuntimeState } from '../hooks/useRuntimeState';
import { useCoachingStore } from '../store/coachingStore';
import { useMissionStore } from '../store/missionStore';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { MomentumHero } from '../features/dashboard/MomentumHero';
import { CoachingWidget } from '../features/coaching/CoachingWidget';
import { PomodoroTimer } from '../components/dashboard/PomodoroTimer';
import { FocusAnalytics } from '../components/focus/FocusAnalytics';
import { RecoveryIntelligence } from '../components/focus/RecoveryIntelligence';
import { MissionControlSection } from '../components/focus/MissionControlSection';
import { RuntimeIntelligenceSection } from '../components/focus/RuntimeIntelligenceSection';
import { FocusTodayCompact } from '../features/focus/components/FocusTodayCompact';
import { FocusResultDialog } from '../features/focus/components/FocusResultDialog';
import { FocusHistoryDrawer } from '../features/focus/components/FocusHistoryDrawer';
import type { FocusSessionModel } from '../features/focus/services/focusService';

const FocusPage: React.FC = () => {
  console.log('[FocusPage] mounted and rendering.');
  const location = useLocation();
  const { data: runtimeState } = useRuntimeState();
  const { momentum } = useCoachingStore();
  const streak = runtimeState?.streak ?? 0;

  const searchParams = new URLSearchParams(location.search);
  const missionParam = searchParams.get('mission')?.trim() || '';
  const durationParam = Number(searchParams.get('duration'));
  const initialDuration = Number.isFinite(durationParam) && durationParam > 0 ? Math.min(180, Math.round(durationParam)) : undefined;
  const initialModeId = searchParams.get('mode')?.trim() || (missionParam ? 'dsa' : undefined);

  const appliedMissionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!missionParam || appliedMissionRef.current === missionParam) return;
    appliedMissionRef.current = missionParam;

    const store = useMissionStore.getState();
    const existing = store.missions.find(
      (m) => m.title.trim().toLowerCase() === missionParam.toLowerCase()
    );
    if (existing) {
      store.setActiveMission(existing.id);
    } else {
      store.createMission({
        title: missionParam,
        description: 'Targeted algorithmic mastery sprint launched from DSA Intelligence.',
        category: 'dsa',
        priority: 'high',
        status: 'active',
        estimatedHours: 1,
        tags: ['dsa', 'readiness'],
      });
    }
  }, [missionParam]);

  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [completedResult, setCompletedResult] = useState<FocusSessionModel | null>(null);
  const [isResultDialogOpen, setIsResultDialogOpen] = useState(false);

  const handleSessionComplete = (result: any) => {
    setCompletedResult(result);
    setIsResultDialogOpen(true);
  };

  // Ambient State Logic
  const isBurnoutRisk = momentum?.momentumScore?.trend === 'critical' || momentum?.momentumScore?.trend === 'declining';
  const isRecovery = momentum?.momentumScore?.trend === 'rising';

  let bgGradient1 = 'from-indigo-200/50 via-purple-200/30';
  let bgGradient2 = 'from-blue-200/50 via-violet-200/30';

  if (isBurnoutRisk) {
    bgGradient1 = 'from-orange-200/50 via-red-200/30';
    bgGradient2 = 'from-amber-200/50 via-orange-200/30';
  } else if (isRecovery) {
    bgGradient1 = 'from-teal-200/50 via-emerald-200/30';
    bgGradient2 = 'from-emerald-200/50 via-cyan-200/30';
  }

  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15,
        delayChildren: 0.1,
      }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 30 },
    show: {
      opacity: 1,
      y: 0,
      transition: { type: 'spring' as const, stiffness: 300, damping: 24 }
    }
  };

  return (
    <ErrorBoundary>
      <framerMotion.div
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="flex flex-col gap-12 max-w-[1400px] mx-auto w-full pb-32 px-4 lg:px-8 relative"
      >
        {/* Ambient State Background */}
        <div className="fixed inset-0 pointer-events-none overflow-hidden -z-10 bg-gradient-to-br from-[#FAFBFD] via-[#F8F9FC] to-[#F6F8FB] dark:from-[#09090B] dark:via-[#0D0D11] dark:to-[#111116] transition-colors duration-1000">
          <div className={`absolute top-[-15%] right-[-8%] w-[900px] h-[900px] bg-[radial-gradient(circle_at_top_right,_var(--tw-gradient-stops))] ${bgGradient1} to-transparent blur-[120px] rounded-full mix-blend-multiply opacity-70 animate-[pulse_8s_ease-in-out_infinite] transition-colors duration-[2000ms]`} />
          <div className={`absolute bottom-[-10%] left-[-12%] w-[700px] h-[700px] bg-[radial-gradient(circle_at_bottom_left,_var(--tw-gradient-stops))] ${bgGradient2} to-transparent blur-[120px] rounded-full mix-blend-multiply opacity-50 animate-[pulse_10s_ease-in-out_infinite_2s] transition-colors duration-[2000ms]`} />
        </div>

        {/* ABOVE THE FOLD */}
        <div className="flex flex-col gap-12 pt-8 relative z-10">
          {/* Operational Momentum (Full Width Row) */}
          <framerMotion.section variants={itemVariants} className="w-full">
            <MomentumHero streak={streak} />
          </framerMotion.section>

          {/* Today's Focus Overview & History Quick Launcher */}
          <framerMotion.section variants={itemVariants} className="w-full">
            <FocusTodayCompact onOpenHistory={() => setIsHistoryDrawerOpen(true)} refreshKey={completedResult} />
          </framerMotion.section>

          {/* Execution Core: RIE + Focus Engine + Mission Control grouped tighter */}
          <div className="flex flex-col gap-6 w-full">

            {/* Runtime Intelligence Engine (RIE) */}
            <framerMotion.section variants={itemVariants} className="w-full mb-2 z-20 relative">
              <RuntimeIntelligenceSection />
            </framerMotion.section>

            {/* Focus Engine (Full Width Row) */}
            <framerMotion.section variants={itemVariants} className="w-full">
              <PomodoroTimer
                showAmbientSound
                initialModeId={initialModeId}
                initialDuration={initialDuration}
                onSessionComplete={handleSessionComplete}
              />
            </framerMotion.section>

            {/* Mission Control (Full Width Row) */}
            <div className="w-full z-20 relative">
              {/* Subtle connecting line to visually bridge them */}
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-[2px] h-3 bg-gradient-to-b from-violet-200 to-transparent opacity-50 pointer-events-none" />
              <MissionControlSection />
            </div>
          </div>

          {/* Neural Coaching (Full width) */}
          <framerMotion.section variants={itemVariants}>
            <CoachingWidget />
          </framerMotion.section>
        </div>

        {/* BELOW THE FOLD */}
        <div className="flex flex-col gap-16 relative z-10">
          <framerMotion.section variants={itemVariants}>
            <FocusAnalytics />
          </framerMotion.section>

          <framerMotion.section variants={itemVariants}>
            <RecoveryIntelligence />
          </framerMotion.section>
        </div>

        {/* Server-Authoritative Focus Result Dialog */}
        <FocusResultDialog
          isOpen={isResultDialogOpen}
          onClose={() => setIsResultDialogOpen(false)}
          result={completedResult}
        />

        {/* Sliding Focus History Drawer */}
        <FocusHistoryDrawer
          isOpen={isHistoryDrawerOpen}
          onClose={() => setIsHistoryDrawerOpen(false)}
        />
      </framerMotion.div>
    </ErrorBoundary>
  );
};

export default FocusPage;
