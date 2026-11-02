import React, { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { motion } from 'framer-motion';
import { SkeletonCard } from '../components/skeletons/SkeletonCard';
import { DashboardSkeleton } from '../components/skeletons/DashboardSkeleton';
import { ErrorBoundary } from '../components/shared/ErrorBoundary';

const DashboardPage = lazy(() => import('../pages/DashboardPage'));
const DsaPage = lazy(() => import('../pages/DsaPage'));
const ProjectsPage = lazy(() => import('../pages/ProjectsPage'));
const SettingsPage = lazy(() => import('../pages/SettingsPage'));
const ProfilePage = lazy(() => import('../pages/ProfilePage'));
const AdminPage = lazy(() => import('../pages/AdminPage'));
const ReadinessPage = lazy(() => import('../pages/ReadinessPage'));

// Resume Tracker Workspace
const ResumeEntryWorkspace = lazy(() => import('../features/resume-tracker/pages/ResumeEntryWorkspace').then(module => ({ default: module.ResumeEntryWorkspace })));
const ResumeAnalysisWorkspace = lazy(() => import('../features/resume-tracker/pages/ResumeAnalysisWorkspace').then(module => ({ default: module.ResumeAnalysisWorkspace })));

// Readiness Domain Workspaces
const DSAIntelligencePage = lazy(() => import('../pages/readiness/DSAIntelligencePage'));
const RoadmapIntelligencePage = lazy(() => import('../pages/readiness/RoadmapIntelligencePage'));
const EvolutionIntelligencePage = lazy(() => import('../pages/readiness/EvolutionIntelligencePage'));
const AIGuidancePage = lazy(() => import('../pages/readiness/AIGuidancePage'));

const skeletonVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

const PageFallback: React.FC<{ useDashboardSkeleton?: boolean }> = ({ useDashboardSkeleton = false }) => (
  <motion.div
    initial="initial"
    animate="animate"
    exit="exit"
    variants={skeletonVariants}
    transition={{ duration: 0.25 }}
  >
    {useDashboardSkeleton ? (
      <DashboardSkeleton />
    ) : (
      <div className="flex flex-col gap-4">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={3} />
      </div>
    )}
  </motion.div>
);

export const AppRouter: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route
        path="/dashboard"
        element={
          <ErrorBoundary pageName="Dashboard">
            <Suspense fallback={<PageFallback useDashboardSkeleton />}>
              <DashboardPage />
            </Suspense>
          </ErrorBoundary>
        }
      />

      <Route
        path="/dsa"
        element={
          <ErrorBoundary pageName="DSA Workspace">
            <Suspense fallback={<PageFallback />}>
              <DsaPage />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/profile"
        element={
          <ErrorBoundary pageName="Progress">
            <Suspense fallback={<PageFallback />}>
              <ProfilePage />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/u/:username"
        element={
          <ErrorBoundary pageName="Public Profile">
            <Suspense fallback={<PageFallback />}>
              <ProfilePage isPublicView={true} />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/settings"
        element={
          <ErrorBoundary pageName="Settings">
            <Suspense fallback={<PageFallback />}>
              <SettingsPage />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/admin"
        element={
          <ErrorBoundary pageName="Admin">
            <Suspense fallback={<PageFallback />}>
              <AdminPage />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/projects"
        element={
          <ErrorBoundary pageName="Projects">
            <Suspense fallback={<PageFallback />}>
              <ProjectsPage />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/resume"
        element={
          <ErrorBoundary pageName="Resume Entry">
            <Suspense fallback={<PageFallback />}>
              <ResumeEntryWorkspace />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/resume/analysis/:sessionId"
        element={
          <ErrorBoundary pageName="Resume Analysis">
            <Suspense fallback={<PageFallback />}>
              <ResumeAnalysisWorkspace />
            </Suspense>
          </ErrorBoundary>
        }
      />

      {/* ─── Readiness Intelligence OS ─── */}
      <Route
        path="/readiness"
        element={
          <ErrorBoundary pageName="Mission Control">
            <Suspense fallback={<PageFallback />}>
              <ReadinessPage />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/readiness/dsa"
        element={
          <ErrorBoundary pageName="DSA Intelligence">
            <Suspense fallback={<PageFallback />}>
              <DSAIntelligencePage />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/readiness/roadmap"
        element={
          <ErrorBoundary pageName="Roadmap Intelligence">
            <Suspense fallback={<PageFallback />}>
              <RoadmapIntelligencePage />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/readiness/evolution"
        element={
          <ErrorBoundary pageName="Evolution Intelligence">
            <Suspense fallback={<PageFallback />}>
              <EvolutionIntelligencePage />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <Route
        path="/readiness/copilot"
        element={
          <ErrorBoundary pageName="AI Guidance">
            <Suspense fallback={<PageFallback />}>
              <AIGuidancePage />
            </Suspense>
          </ErrorBoundary>
        }
      />

      <Route path="/goals" element={<Navigate to="/dashboard" replace />} />
      <Route path="/challenges" element={<Navigate to="/dashboard" replace />} />
      <Route path="/achievements" element={<Navigate to="/profile" replace />} />
      <Route path="/leaderboard" element={<Navigate to="/profile" replace />} />
      <Route path="/notifications" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
};
