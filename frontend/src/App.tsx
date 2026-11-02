import React, { useEffect, Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { SignedIn, SignedOut, useAuth } from '@clerk/clerk-react';
import { ToastContainer } from './components/shared/ToastContainer';
import { AppShell } from './components/layout/AppShell';
import { AppProviders } from './providers/AppProviders';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { LandingPage } from './pages/LandingPage';
import FocusPage from './pages/FocusPage';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { springCalm } from './lib/motion';
import { useUserStore } from './store/userStore';
import { SkeletonCard } from './components/skeletons/SkeletonCard';
import { DashboardSkeleton } from './components/skeletons/DashboardSkeleton';

// Lazy Loaded Pages
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const DsaPage = lazy(() => import('./pages/DsaPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const ReadinessPage = lazy(() => import('./pages/ReadinessPage'));

// Resume Tracker Workspace
const ResumeEntryWorkspace = lazy(() => import('./features/resume-tracker/pages/ResumeEntryWorkspace').then(module => ({ default: module.ResumeEntryWorkspace })));
const ResumeAnalysisWorkspace = lazy(() => import('./features/resume-tracker/pages/ResumeAnalysisWorkspace').then(module => ({ default: module.ResumeAnalysisWorkspace })));

// Readiness Domain Workspaces
const DSAIntelligencePage = lazy(() => import('./pages/readiness/DSAIntelligencePage'));
const RoadmapIntelligencePage = lazy(() => import('./pages/readiness/RoadmapIntelligencePage'));
const EvolutionIntelligencePage = lazy(() => import('./pages/readiness/EvolutionIntelligencePage'));
const AIGuidancePage = lazy(() => import('./pages/readiness/AIGuidancePage'));
const BetaDashboardPage = lazy(() => import('./pages/admin/BetaDashboardPage'));

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

const BootSplash: React.FC = () => (
  <motion.div 
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    transition={springCalm}
    className="min-h-screen flex items-center justify-center bg-[#0a0a0b]"
  >
    <div className="flex flex-col items-center gap-6">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.1, ...springCalm }}
        className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20"
      >
        <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
      </motion.div>
      <motion.span 
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, ...springCalm }}
        className="text-sm font-medium text-zinc-400 tracking-wide"
      >
        Loading DevTrack…
      </motion.span>
    </div>
  </motion.div>
);

const AuthSyncGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isLoaded, isSignedIn } = useAuth();
  const fetchMe = useUserStore((s) => s.fetchMe);
  const user = useUserStore((s) => s.user);

  useEffect(() => {
    if (isLoaded && isSignedIn && !user) {
      // Sync local user store with our backend when Clerk says we are signed in
      fetchMe();
    }
  }, [isLoaded, isSignedIn, user, fetchMe]);

  if (!isLoaded) {
    return <BootSplash />;
  }

  return <>{children}</>;
};

/**
 * ProtectedLayout — renders AppShell (with Outlet) for signed-in users,
 * or redirects to /login for signed-out users.
 * Using useAuth directly avoids React Router v7 issues with Clerk's
 * <SignedIn>/<SignedOut> conditional wrappers inside layout route elements.
 */
const ProtectedLayout: React.FC = () => {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) return null;
  if (!isSignedIn) return <Navigate to="/login" replace />;

  return <AppShell />;
};

function App() {
  return (
    <BrowserRouter>
      <AppProviders>
        <ToastContainer />
        <AuthSyncGate>
          <ErrorBoundary pageName="App">
            <Routes>
              {/* Public Routes */}
              <Route path="/" element={
                <>
                  <SignedIn><Navigate to="/dashboard" replace /></SignedIn>
                  <SignedOut><LandingPage /></SignedOut>
                </>
              } />
              
              <Route path="/login/*" element={
                <>
                  <SignedIn><Navigate to="/dashboard" replace /></SignedIn>
                  <SignedOut><LoginPage /></SignedOut>
                </>
              } />

              <Route path="/signup/*" element={
                <>
                  <SignedIn><Navigate to="/dashboard" replace /></SignedIn>
                  <SignedOut><SignupPage /></SignedOut>
                </>
              } />

              {/* Protected Routes Layout */}
              <Route element={<ProtectedLayout />}>
                {/* ─── Flat Route Definitions ─── */}
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
                  path="/focus"
                  element={
                    <ErrorBoundary pageName="Focus">
                      <FocusPage />
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
                  path="/beta/dashboard"
                  element={
                    <ErrorBoundary pageName="Beta Dashboard">
                      <Suspense fallback={<PageFallback />}>
                        <BetaDashboardPage />
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
              </Route>
            </Routes>
          </ErrorBoundary>
        </AuthSyncGate>
      </AppProviders>
    </BrowserRouter>
  );
}

export default App;
