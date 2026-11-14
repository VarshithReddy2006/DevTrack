import React, { useCallback, useEffect, useRef, useState } from 'react';
import { analyticsService } from '../../services/analyticsService';
import { Target, Activity, MessageSquare, RefreshCw, TrendingUp } from 'lucide-react';
import { EmptyState } from '../../components/shared/EmptyState';
import { WorkspaceHeader } from '../../features/readiness/components/WorkspaceHeader';

interface DashboardMetrics {
  funnel: {
    resumesUploaded: number;
    discoveryCompleted: number;
    roadmapsGenerated: number;
    resourceClicks: number;
    skillsCompleted: number;
  };
  metrics: {
    activationRate: number;
    learningEngagement: number;
    completionRate: number;
  };
  feedback: Array<{ _id: string; rating: string; page: string; feedback?: string; createdAt: string }>;
}

const PAGE_SIZE = 6;

export const BetaDashboardPage: React.FC = () => {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [rating, setRating] = useState('');
  const [page, setPage] = useState(1);
  const fetching = useRef(false);

  const fetchMetrics = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setLoading(true);
    setLoadFailed(false);
    try {
      const data: DashboardMetrics | null | undefined = await analyticsService.getDashboardMetrics();
      if (!data) {
        setLoadFailed(true);
        return;
      }
      setMetrics(data);
      setRating((current) => data.feedback.some((entry) => entry.rating === current) ? current : '');
      setPage(1);
    } catch {
      setLoadFailed(true);
    } finally {
      fetching.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMetrics();
  }, [fetchMetrics]);

  if (loading && !metrics) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-64px)] bg-[#FAFAFC]">
        <div className="animate-pulse flex flex-col items-center">
          <Activity className="w-10 h-10 text-indigo-500 animate-bounce" />
          <p className="mt-4 text-slate-500 font-medium">Loading Beta Metrics...</p>
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#FAFAFC]">
        <EmptyState
          title="Failed to load metrics"
          description="Try fetching the dashboard metrics again."
          action={
            <button type="button" onClick={fetchMetrics} className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white">
              Retry
            </button>
          }
        />
      </div>
    );
  }

  const { funnel, metrics: pmf, feedback } = metrics;
  const ratings = [...new Set(feedback.map((entry) => entry.rating))];
  const filteredFeedback = rating ? feedback.filter((entry) => entry.rating === rating) : feedback;
  const pageCount = Math.ceil(filteredFeedback.length / PAGE_SIZE);
  const visibleFeedback = filteredFeedback.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="w-full min-h-[calc(100vh-64px)] bg-[#FAFAFC] flex flex-col text-slate-900 relative">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#8B5CF60A_1px,transparent_1px),linear-gradient(to_bottom,#8B5CF60A_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none" />
      
      <div className="flex-1 w-full max-w-[1400px] mx-auto flex flex-col px-6 lg:px-10 py-10 relative z-10">
        <WorkspaceHeader 
          domain="Admin"
          title="Beta Program Dashboard"
          coreQuestion="Real-time product-market fit metrics and user telemetry for V1 Validation."
          icon={<Activity size={20} />}
          accentColor="#10B981"
          actions={
            <button
              type="button"
              onClick={fetchMetrics}
              disabled={loading}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-60"
            >
              <RefreshCw size={16} aria-hidden="true" className={loading ? 'motion-safe:animate-spin' : undefined} />
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          }
        />
        {loadFailed && (
          <p role="alert" className="text-sm text-red-600">Could not refresh metrics. Showing the last loaded data.</p>
        )}

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <MetricCard title="Activation Rate" value={`${pmf.activationRate.toFixed(1)}%`} subtitle="Uploads -> Roadmaps" icon={Target} color="emerald" />
          <MetricCard title="Learning Engagement" value={`${pmf.learningEngagement.toFixed(1)}%`} subtitle="Roadmaps -> Resource Clicked" icon={TrendingUp} color="indigo" />
          <MetricCard title="Completion Rate" value={`${pmf.completionRate.toFixed(1)}%`} subtitle="Roadmaps -> First Skill Done" icon={Activity} color="violet" />
        </div>

        <div className="mt-8 bg-white border border-slate-200 rounded-3xl p-8 shadow-sm">
          <h3 className="text-xl font-bold text-slate-800 mb-6 flex items-center gap-2">
            <Activity className="w-5 h-5 text-indigo-500" />
            Conversion Funnel
          </h3>
          <div className="flex flex-col gap-4">
            <FunnelStep label="Resumes Uploaded" value={funnel.resumesUploaded} max={funnel.resumesUploaded} />
            <FunnelStep label="Career Discovery" value={funnel.discoveryCompleted} max={funnel.resumesUploaded} />
            <FunnelStep label="Roadmaps Generated" value={funnel.roadmapsGenerated} max={funnel.resumesUploaded} />
            <FunnelStep label="Resources Clicked" value={funnel.resourceClicks} max={funnel.resumesUploaded} />
            <FunnelStep label="Skills Completed" value={funnel.skillsCompleted} max={funnel.resumesUploaded} />
          </div>
        </div>

        <div className="mt-8 bg-white border border-slate-200 rounded-3xl p-8 shadow-sm">
          <h3 className="text-xl font-bold text-slate-800 mb-6 flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-indigo-500" />
            User Feedback
          </h3>
          {feedback.length > 0 && (
            <label className="mb-4 flex flex-wrap items-center gap-2 text-sm font-medium text-slate-700">
              Filter by rating
              <select
                value={rating}
                onChange={(event) => {
                  setRating(event.target.value);
                  setPage(1);
                }}
                className="rounded-lg border border-slate-200 px-3 py-2"
              >
                <option value="">All ratings</option>
                {ratings.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          )}
          {feedback.length === 0 ? (
            <p className="text-slate-500 text-sm">No feedback collected yet.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {visibleFeedback.map((f) => (
                <div key={f._id} className="p-4 bg-slate-50 border border-slate-100 rounded-2xl flex gap-4">
                  <div className="text-3xl">{f.rating}</div>
                  <div>
                    <p className="text-sm font-bold text-slate-700">Page: {f.page}</p>
                    <p className="text-sm text-slate-600 mt-1">{f.feedback || 'No written feedback provided.'}</p>
                    <p className="text-xs text-slate-400 mt-2">{new Date(f.createdAt).toLocaleString()}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {pageCount > 1 && (
            <nav aria-label="Feedback pagination" className="mt-4 flex flex-wrap items-center gap-3 text-sm">
              <button
                type="button"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
                className="rounded-lg border border-slate-200 px-3 py-2 disabled:opacity-50"
              >
                Previous
              </button>
              <span aria-live="polite">Page {page} of {pageCount}</span>
              <button
                type="button"
                disabled={page === pageCount}
                onClick={() => setPage(page + 1)}
                className="rounded-lg border border-slate-200 px-3 py-2 disabled:opacity-50"
              >
                Next
              </button>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
};

const MetricCard: React.FC<{ title: string; value: string; subtitle: string; icon: any; color: string }> = ({ title, value, subtitle, icon: Icon, color }) => {
  const colorMap: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-600 border-emerald-100',
    indigo: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    violet: 'bg-violet-50 text-violet-600 border-violet-100',
  };
  
  return (
    <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm flex flex-col">
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${colorMap[color]}`}>
          <Icon className="w-5 h-5" />
        </div>
        <h4 className="font-bold text-slate-600 tracking-tight">{title}</h4>
      </div>
      <div className="text-4xl font-black text-slate-800 tracking-tight mb-2">{value}</div>
      <p className="text-sm font-medium text-slate-500">{subtitle}</p>
    </div>
  );
};

const FunnelStep: React.FC<{ label: string; value: number; max: number }> = ({ label, value, max }) => {
  const percentage = max > 0 ? (value / max) * 100 : 0;
  
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center text-sm font-bold">
        <span className="text-slate-700">{label}</span>
        <span className="text-slate-900">{value} <span className="text-slate-400 font-medium">({percentage.toFixed(1)}%)</span></span>
      </div>
      <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
        <div 
          className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full transition-all duration-1000"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
};

export default BetaDashboardPage;
