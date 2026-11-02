import React, { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '@clerk/clerk-react';
import { ToastContainer } from './components/shared/ToastContainer';
import { AppProviders } from './providers/AppProviders';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { AppRouter } from './router';
import { springCalm } from './lib/motion';
import { useUserStore } from './store/userStore';
import { prepareAccount } from './lib/accountBoundary';

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

export const AuthSyncGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const identity = isSignedIn ? userId : null;
  const [readyIdentity, setReadyIdentity] = useState<string | null | undefined>(undefined);
  const fetchMe = useUserStore((s) => s.fetchMe);
  const user = useUserStore((s) => s.user);

  useEffect(() => {
    if (!isLoaded || (isSignedIn && !userId)) return;
    let active = true;
    void prepareAccount(identity ?? null, undefined, () => active).then(ready => {
      if (active && ready) setReadyIdentity(identity ?? null);
    }).catch(error => console.error('Failed to isolate account state', error));
    return () => { active = false; };
  }, [isLoaded, isSignedIn, userId, identity]);

  useEffect(() => {
    if (isLoaded && isSignedIn && readyIdentity === identity && !user) {
      // Sync local user store with our backend when Clerk says we are signed in
      fetchMe();
    }
  }, [isLoaded, isSignedIn, identity, readyIdentity, user, fetchMe]);

  if (!isLoaded || (isSignedIn && !userId) || readyIdentity !== identity) {
    return <BootSplash />;
  }

  return <>{children}</>;
};

function App() {
  return (
    <AuthSyncGate>
      <BrowserRouter>
        <AppProviders>
          <ToastContainer />
          <ErrorBoundary pageName="App">
            <AppRouter />
          </ErrorBoundary>
        </AppProviders>
      </BrowserRouter>
    </AuthSyncGate>
  );
}

export default App;
