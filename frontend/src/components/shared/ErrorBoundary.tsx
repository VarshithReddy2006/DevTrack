// ============================================================================
// ErrorBoundary.tsx — Feature-Level Error Boundary
// ============================================================================
// Catches errors and provides graceful fallback UI with retry.
// ============================================================================

import React, { Component, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '../ui';
import { captureBoundaryError } from '../../lib/sentry';
import { CrashFeedbackDialog } from './CrashFeedbackDialog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  /**
   * Child components
   */
  children: ReactNode;
  
  /**
   * Feature name for error reporting
   */
  featureName?: string;

  /**
   * Page name (alternative name for featureName)
   */
  pageName?: string;
  
  /**
   * Custom fallback UI
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  
  /**
   * Error callback
   */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** Sentry event id for the current crash; unset when reporting is off. */
  eventId?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log error to console in development
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    }

    // Call error callback
    this.props.onError?.(error, errorInfo);

    // Report to Sentry (no-op without a DSN), keeping the id for the feedback form
    this.setState({ eventId: captureBoundaryError(error, errorInfo) });
  }

  reset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      eventId: undefined,
    });
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }

      // Default fallback UI
      return (
        <DefaultErrorFallback
          error={this.state.error}
          featureName={this.props.featureName || this.props.pageName}
          eventId={this.state.eventId}
          onReset={this.reset}
        />
      );
    }

    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Default Fallback UI
// ---------------------------------------------------------------------------

interface DefaultErrorFallbackProps {
  error: Error;
  featureName?: string;
  eventId?: string;
  onReset: () => void;
}

const DefaultErrorFallback: React.FC<DefaultErrorFallbackProps> = ({
  error,
  featureName,
  eventId,
  onReset,
}) => {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <>
      <div role="alert" className="flex items-center justify-center min-h-[400px] p-8">
        <div className="max-w-md w-full text-center">
          {/* Icon */}
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-50 flex items-center justify-center">
            <AlertTriangle size={32} className="text-red-500" />
          </div>

          {/* Title */}
          <h2 className="text-xl font-black text-dt-text mb-2">
            {featureName ? `${featureName} Error` : 'Something went wrong'}
          </h2>

          {/* Message */}
          <p className="text-sm text-dt-textSecondary mb-6">
            {import.meta.env.DEV
              ? error.message
              : 'An unexpected error occurred. Please try again.'}
          </p>

          {/* Actions */}
          <div className="flex gap-3 justify-center">
            <Button
              variant="primary"
              icon={<RefreshCw size={16} />}
              onClick={onReset}
            >
              Try Again
            </Button>
          
            <Button
              variant="secondary"
              onClick={() => window.location.href = '/dashboard'}
            >
              Go to Dashboard
            </Button>
          </div>

          {eventId && (
            <button
              type="button"
              onClick={() => setFeedbackOpen(true)}
              className="mt-4 text-sm font-medium text-zinc-500 underline hover:text-zinc-700"
            >
              Report an issue
            </button>
          )}

          {/* Stack trace in development */}
          {import.meta.env.DEV && error.stack && (
            <details className="mt-6 text-left">
              <summary className="text-xs font-bold text-gray-500 cursor-pointer hover:text-gray-700">
                Error Details
              </summary>
              <pre className="mt-2 p-4 bg-gray-50 rounded-lg text-xs text-gray-700 overflow-auto max-h-48">
                {error.stack}
              </pre>
            </details>
          )}
        </div>
      </div>
      {eventId && (
        <CrashFeedbackDialog
          open={feedbackOpen}
          eventId={eventId}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Feature-Specific Boundaries
// ---------------------------------------------------------------------------

export const DashboardBoundary: React.FC<{ children: ReactNode }> = ({ children }) => (
  <ErrorBoundary featureName="Dashboard">
    {children}
  </ErrorBoundary>
);

export const ProjectsBoundary: React.FC<{ children: ReactNode }> = ({ children }) => (
  <ErrorBoundary featureName="Projects">
    {children}
  </ErrorBoundary>
);

export const RealtimeBoundary: React.FC<{ children: ReactNode }> = ({ children }) => (
  <ErrorBoundary featureName="Realtime">
    {children}
  </ErrorBoundary>
);

export const OverlayBoundary: React.FC<{ children: ReactNode }> = ({ children }) => (
  <ErrorBoundary featureName="Overlay">
    {children}
  </ErrorBoundary>
);

export const KanbanBoundary: React.FC<{ children: ReactNode }> = ({ children }) => (
  <ErrorBoundary featureName="Kanban Board">
    {children}
  </ErrorBoundary>
);

export default ErrorBoundary;
