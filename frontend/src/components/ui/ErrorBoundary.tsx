// src/components/ui/ErrorBoundary.tsx — Graceful failure boundary
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { captureBoundaryError } from '../../lib/sentry';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
    captureBoundaryError(error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  private handleGoHome = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-[400px] w-full flex flex-col items-center justify-center p-8 text-center bg-white/50 backdrop-blur-xl rounded-[32px] border border-rose-100 shadow-xl shadow-rose-500/5">
          <div className="w-20 h-20 rounded-full bg-rose-50 flex items-center justify-center mb-6 border border-rose-100">
            <AlertTriangle size={40} className="text-rose-500" />
          </div>
          
          <h2 className="text-xl font-bold text-slate-800 tracking-tight mb-2">
            Intelligence Feed Degraded
          </h2>
          
          <p className="text-sm text-slate-500 font-medium max-w-[400px] mb-8 leading-relaxed">
            This module is currently operating in a degraded state. Core platform features remain unaffected. Our systems are actively recovering this component.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-sm">
            <button
              onClick={this.handleReset}
              className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-slate-800 text-white font-bold text-xs shadow-sm hover:bg-slate-700 transition-all"
            >
              <RefreshCw size={14} />
              <span>Retry Connection</span>
            </button>
            <button
              onClick={this.handleGoHome}
              className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 font-bold text-xs hover:bg-slate-100 transition-all"
            >
              <Home size={14} />
              <span>Return Home</span>
            </button>
          </div>

          {import.meta.env?.DEV && this.state.error && (
            <div className="mt-8 p-4 rounded-xl bg-slate-900 text-rose-300 text-left overflow-auto max-w-full font-mono text-[10px] w-full">
              <p className="font-bold mb-2">Debug Info:</p>
              {this.state.error.stack}
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
