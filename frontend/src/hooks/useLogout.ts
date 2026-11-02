import { useRef, useState } from 'react';
import { useClerk } from '@clerk/clerk-react';
import { useUserStore } from '../store/userStore';
import { useUIStore } from '../store/uiStore';
import { beginSignOut, finishSignOut } from '../lib/signOutBarrier';

export function useLogout(redirectTo: '/' | '/login') {
  const { signOut } = useClerk();
  const logoutCleanup = useUserStore(s => s.logoutCleanup);
  const addToast = useUIStore(s => s.addToast);
  const pending = useRef(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const logout = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsLoggingOut(true);
    beginSignOut();

    try {
      // The callback replaces Clerk's default redirect, so cleanup finishes
      // before navigation even if the protected page unmounts on sign-out.
      await signOut(async () => {
        try {
          await logoutCleanup();
        } catch {
          useUserStore.getState().clearUser();
          addToast({
            type: 'error', title: 'Session ended', duration: 0,
            message: 'Could not clear all local data. Reload before signing in again.',
          });
        }
        // The account boundary may have unmounted this hook while cleanup ran.
        window.history.replaceState(null, '', redirectTo);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
    } catch {
      addToast({
        type: 'error', title: 'Could not sign out', duration: 0,
        message: 'Please try again. If this continues, reload the page.',
      });
    } finally {
      finishSignOut();
      pending.current = false;
      setIsLoggingOut(false);
    }
  };

  return { logout, isLoggingOut };
}
