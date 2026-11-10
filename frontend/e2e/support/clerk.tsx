import type { ReactNode } from 'react';

// Browser-only Clerk stand-in for the disposable E2E API. It supplies a fixed
// identity and token; no production authentication code is changed.
if (typeof window !== 'undefined') {
  (window as Window & { Clerk?: unknown }).Clerk = {
    session: { getToken: async () => 'devtrack-e2e-token' },
  };
}

const auth = { isLoaded: true, isSignedIn: true, userId: 'e2e_clerk_user' };
export const useAuth = () => auth;
export const useClerk = () => ({ signOut: async () => undefined });
export const ClerkProvider = ({ children }: { children: ReactNode }) => children;
export const SignedIn = ({ children }: { children: ReactNode }) => children;
export const SignedOut = () => null;
export const UserButton = () => null;
export const SignIn = () => null;
export const SignUp = () => null;
