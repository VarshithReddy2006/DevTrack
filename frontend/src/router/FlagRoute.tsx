import type { ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useFeatureFlags } from '../features/flags/hooks/useFeatureFlags';
import { getErrorCopy } from '../lib/errorCopy';

interface FlagRouteProps {
  flagKey: string;
  children: ReactNode;
  fallback?: ReactNode;
  redirectTo?: string;
}

export function FlagRoute({ flagKey, children, fallback, redirectTo }: FlagRouteProps) {
  const { isLoading, isEnabled, error, retry } = useFeatureFlags();

  if (isLoading) return <p role="status" className="p-4">Checking feature availability…</p>;

  if (error) {
    return (
      <section className="space-y-2 p-4" aria-label="Feature availability">
        <p role="alert">Couldn’t check feature availability.</p>
        <button type="button" className="underline" onClick={() => void retry()}>Try again</button>
      </section>
    );
  }

  if (isEnabled(flagKey)) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  if (redirectTo) return <Navigate to={redirectTo} replace />;

  const copy = getErrorCopy('FEATURE_DISABLED');
  return (
    <section className="space-y-2 p-4">
      <h2 className="font-semibold">{copy.title}</h2>
      <p>{copy.description}</p>
      <Link to="/dashboard" className="underline">{copy.actionLabel}</Link>
    </section>
  );
}
