import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Shield, 
  Activity, 
  Users, 
  CheckCircle, 
  AlertTriangle, 
  Sliders, 
  AlertCircle, 
  Mail, 
  Plus, 
  Percent,
  RefreshCw,
  XOctagon,
  Radio,
  Zap,
  Server
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axiosClient from '../utils/axiosClient';
import { Card, CardHeader, CardTitle, CardContent, Button, Badge } from '../components/ui';
import { getTelemetryBuffer } from '../lib/telemetry';
import { useSse } from '../hooks/useSse';
import { useUIStore } from '../store/uiStore';

type Tab = 
  | 'retention' | 'beta' | 'feature-gates' | 'kill-switches' | 'system'
  | 'profile-integrity' | 'trust-scores' | 'verification-audits' | 'anomaly-detection' | 'timeline-integrity' | 'recruiter-signals'
  | 'cache-health' | 'public-apis' | 'seo-health' | 'traffic-monitoring'
  | 'suspicious-accounts' | 'abuse-investigations' | 'verification-locks' | 'manual-overrides';

const CATEGORIES = [
  {
    name: 'Operations',
    tabs: [
      { id: 'retention', label: 'Retention' },
      { id: 'feature-gates', label: 'Feature Gates' },
      { id: 'kill-switches', label: 'Kill Switches' },
      { id: 'system', label: 'System Health' },
    ]
  },
  {
    name: 'Trust Infrastructure',
    tabs: [
      { id: 'profile-integrity', label: 'Profile Integrity' },
      { id: 'trust-scores', label: 'Trust Scores' },
      { id: 'verification-audits', label: 'Verification Audits' },
      { id: 'anomaly-detection', label: 'Anomaly Detection' },
      { id: 'timeline-integrity', label: 'Timeline Integrity' },
      { id: 'recruiter-signals', label: 'Recruiter Signals' },
    ]
  },
  {
    name: 'Public Systems',
    tabs: [
      { id: 'cache-health', label: 'Cache Health' },
      { id: 'public-apis', label: 'Public APIs' },
      { id: 'seo-health', label: 'SEO Health' },
      { id: 'traffic-monitoring', label: 'Traffic Monitoring' },
    ]
  },
  {
    name: 'Moderation',
    tabs: [
      { id: 'suspicious-accounts', label: 'Suspicious Accounts' },
      { id: 'abuse-investigations', label: 'Abuse Investigations' },
      { id: 'verification-locks', label: 'Verification Locks' },
      { id: 'manual-overrides', label: 'Manual Overrides' },
    ]
  }
];

export const AdminPage = () => {
  const [activeTab, setActiveTab] = useState<Tab>('retention');
  const queryClient = useQueryClient();
  const telemetry = getTelemetryBuffer().slice(-8).reverse();
  const { connectionStatus } = useSse();
  const sseStatus = useUIStore((s) => s.sseStatus);

  // ─── Queries ───
  const { data: retentionData, isLoading: loadingRetention, refetch: refetchRetention } = useQuery({
    queryKey: ['ops-retention'],
    queryFn: async () => {
      const { data } = await axiosClient.get('/ops/retention/dashboard');
      return data;
    },
    refetchInterval: 15000,
  });

  const { data: betaData, isLoading: loadingBeta, refetch: refetchBeta } = useQuery({
    queryKey: ['ops-beta'],
    queryFn: async () => {
      const { data } = await axiosClient.get('/ops/beta/status');
      return data;
    },
  });

  const { data: featureGatesData, isLoading: loadingGates, refetch: refetchGates } = useQuery({
    queryKey: ['ops-feature-gates'],
    queryFn: async () => {
      const { data } = await axiosClient.get('/ops/feature-gates');
      return data;
    },
  });

  const { data: killSwitchesData, isLoading: loadingSwitches, refetch: refetchSwitches } = useQuery({
    queryKey: ['ops-kill-switches'],
    queryFn: async () => {
      const { data } = await axiosClient.get('/ops/kill-switches');
      return data;
    },
  });

  const { data: systemMetrics, isLoading: loadingMetrics, refetch: refetchMetrics } = useQuery({
    queryKey: ['ops-metrics'],
    queryFn: async () => {
      const { data } = await axiosClient.get('/ops/metrics');
      return data;
    },
    refetchInterval: 10000,
  });

  // ─── Mutations ───
  const toggleGateMutation = useMutation({
    mutationFn: async ({ featureName, enabled }: { featureName: string; enabled: boolean }) => {
      const { data } = await axiosClient.post('/ops/feature-gates/toggle', { featureName, enabled });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ops-feature-gates'] }),
  });

  const configureGateMutation = useMutation({
    mutationFn: async (payload: { featureName: string; rolloutPercentage: number; rules?: any }) => {
      const { data } = await axiosClient.post('/ops/feature-gates/configure', payload);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ops-feature-gates'] }),
  });

  const toggleKillSwitchMutation = useMutation({
    mutationFn: async ({ switchId, enabled, reason }: { switchId: string; enabled: boolean; reason: string }) => {
      const { data } = await axiosClient.post('/ops/kill-switches/toggle', { switchId, enabled, reason });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ops-kill-switches'] });
      queryClient.invalidateQueries({ queryKey: ['ops-retention'] });
    },
  });

  const generateInviteMutation = useMutation({
    mutationFn: async (payload: { email: string; cohortId: string }) => {
      const { data } = await axiosClient.post('/ops/beta/invites', payload);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ops-beta'] }),
  });

  const createCohortMutation = useMutation({
    mutationFn: async (payload: { name: string; description: string; type: string; targetSize: number }) => {
      const { data } = await axiosClient.post('/ops/beta/cohorts', payload);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ops-beta'] }),
  });

  // ─── Forms State ───
  const [inviteForm, setInviteForm] = useState({ email: '', cohortId: '' });
  const [cohortForm, setCohortForm] = useState({ name: '', description: '', type: 'alpha', targetSize: 50 });
  const [switchReason, setSwitchReason] = useState<Record<string, string>>({});

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-24 px-4 font-sans text-zinc-100 flex flex-col min-h-[calc(100vh-80px)]">
      {/* ─── Header ─── */}
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800/60 pb-5 pt-4">
        <div>
          <div className="flex items-center gap-2 text-emerald-400 mb-1.5">
            <Shield size={16} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Platform Trust Operations</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-50 tracking-tight">Trust & Platform Ops</h1>
          <p className="text-xs text-zinc-500 mt-1 max-w-xl">
            Internal visibility layer for public credibility systems, profile integrity, queue orchestration, and anomaly tracking.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={connectionStatus === 'connected' ? 'success' : 'warning'} className="px-3 py-1 text-xs">
            SSE Link: {connectionStatus}
          </Badge>
          <Button 
            variant="secondary" 
            size="sm" 
            onClick={() => {
              refetchRetention();
              refetchBeta();
              refetchGates();
              refetchSwitches();
              refetchMetrics();
            }}
            className="border-zinc-800/80 hover:bg-zinc-950/60 hover:text-white"
          >
            <RefreshCw size={14} className="mr-2 animate-spin-hover" />
            Sync Now
          </Button>
        </div>
      </header>

      <div className="flex flex-1 gap-8">
        {/* ─── Navigation Sidebar ─── */}
        <div className="w-56 shrink-0 space-y-6 border-r border-zinc-800/60 pr-4 hidden md:block">
          {CATEGORIES.map(category => (
            <div key={category.name}>
              <h3 className="text-[10px] uppercase font-bold tracking-widest text-zinc-500 mb-2">{category.name}</h3>
              <div className="flex flex-col gap-1">
                {category.tabs.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as Tab)}
                    className={`
                      text-left px-3 py-1.5 text-xs font-semibold rounded-lg transition-all duration-200
                      ${activeTab === tab.id 
                        ? 'bg-zinc-900 border border-zinc-800/50 text-emerald-400 shadow-sm' 
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/30 border border-transparent'
                      }
                    `}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* ─── Content Render ─── */}
        <div className="flex-1 min-w-0">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.25 }}
            >
              {activeTab === 'retention' && <RetentionDashboard data={retentionData} loading={loadingRetention} />}
              
              {activeTab === 'beta' && (
                <BetaManagementTab 
                  data={betaData} loading={loadingBeta}
                  inviteForm={inviteForm} setInviteForm={setInviteForm}
                  cohortForm={cohortForm} setCohortForm={setCohortForm}
                  generateInvite={generateInviteMutation} createCohort={createCohortMutation}
                />
              )}

              {activeTab === 'feature-gates' && (
                <FeatureGatesTab 
                  data={featureGatesData} loading={loadingGates}
                  toggleGate={toggleGateMutation} configureGate={configureGateMutation}
                />
              )}

              {activeTab === 'kill-switches' && (
                <KillSwitchesTab 
                  data={killSwitchesData} loading={loadingSwitches}
                  toggleSwitch={toggleKillSwitchMutation} switchReason={switchReason} setSwitchReason={setSwitchReason}
                />
              )}

              {activeTab === 'system' && (
                <SystemTab 
                  metrics={systemMetrics} loading={loadingMetrics}
                  telemetry={telemetry} sseStatus={sseStatus} connectionStatus={connectionStatus}
                />
              )}
              
              {activeTab === 'cache-health' && <CacheHealthTab />}
              {activeTab === 'trust-scores' && <TrustScoresTab />}
              {activeTab === 'verification-audits' && <VerificationAuditsTab />}
              {activeTab === 'manual-overrides' && <ManualOverridesTab />}

              {/* Placeholder for new tabs */}
              {![...CATEGORIES[0].tabs.map(t=>t.id), 'beta', 'cache-health', 'trust-scores', 'verification-audits', 'manual-overrides'].includes(activeTab) && (
                <div className="flex flex-col items-center justify-center py-32 text-center border border-dashed border-zinc-800 rounded-xl">
                  <Activity className="text-zinc-600 mb-3" size={24} />
                  <p className="text-sm font-bold text-zinc-300 capitalize">{activeTab.replace('-', ' ')}</p>
                  <p className="text-xs text-zinc-500 mt-1">Component coming online...</p>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

/* ─── TAB 1: RETENTION DASHBOARD ─── */
interface RetentionDashboardProps {
  data: any;
  loading: boolean;
}

const RetentionDashboard: React.FC<RetentionDashboardProps> = ({ data, loading }) => {
  if (loading) return <TabLoader />;
  if (!data?.success) return <TabError error="Could not load retention console metrics." />;

  const { metrics, cohorts, summary, alerts } = data;

  return (
    <div className="space-y-6">
      {/* ─── Operations Health Matrix ─── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <HealthMetricCard label="System Integrity" value={`${summary.overall}%`} status={summary.overall > 80 ? 'healthy' : 'warning'} />
        <HealthMetricCard label="Behavioral Momentum" value={`${summary.momentum}%`} status={summary.momentum > 70 ? 'healthy' : 'warning'} />
        <HealthMetricCard label="Fatigue Shield" value={`${summary.fatigue}%`} status={summary.fatigue > 60 ? 'healthy' : 'warning'} />
        <HealthMetricCard label="Experience Quality" value={`${summary.quality}%`} status={summary.quality > 85 ? 'healthy' : 'warning'} />
        <HealthMetricCard label="Pacing Security" value={`${summary.safety}%`} status={summary.safety > 90 ? 'healthy' : 'warning'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ─── Operational Alerts ─── */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="bg-zinc-950/40 border-zinc-800/80">
            <CardHeader className="pb-3 border-b border-zinc-900">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <AlertTriangle size={15} className="text-yellow-500" />
                  Active Telemetry Anomalies
                </CardTitle>
                <Badge variant={alerts.length === 0 ? 'success' : 'error'} className="text-[10px] uppercase font-bold tracking-wider px-2">
                  {alerts.length === 0 ? 'Clear' : `${alerts.length} Warnings`}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              {alerts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <CheckCircle size={24} className="text-emerald-500 mb-2 opacity-80" />
                  <p className="text-xs text-zinc-400 font-medium">All behavioral systems operating within standard deviations.</p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {alerts.map((alert: any, i: number) => (
                    <li key={i} className="flex items-start justify-between bg-zinc-900/30 border border-zinc-850 p-3 rounded-xl gap-3">
                      <div className="flex items-start gap-2.5">
                        <div className={`p-1 rounded-lg shrink-0 mt-0.5 ${alert.severity === 'critical' ? 'bg-red-500/10 text-red-500' : 'bg-yellow-500/10 text-yellow-500'}`}>
                          <AlertCircle size={14} />
                        </div>
                        <div>
                          <p className="text-xs font-bold text-zinc-200 capitalize">{alert.system} Engine Out of Bound</p>
                          <p className="text-[11px] text-zinc-500 mt-0.5">{alert.message}</p>
                        </div>
                      </div>
                      <span className="text-[9px] font-semibold font-mono text-zinc-600 shrink-0">
                        {new Date(alert.timestamp).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ─── Cohort Segmentation Analysis ─── */}
          <Card className="bg-zinc-950/40 border-zinc-800/80">
            <CardHeader className="pb-3 border-b border-zinc-900">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Users size={15} className="text-emerald-400" />
                Active Cohort Retentiveness (D7 Rolling)
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="space-y-4">
                {cohorts.map((cohort: any, i: number) => (
                  <div key={i} className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-zinc-300 font-mono">{cohort.cohortDate}</span>
                        <span className="text-[10px] text-zinc-500">({cohort.totalUsers} users)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-500 font-medium">Score:</span>
                        <span className={`font-bold font-mono ${cohort.healthScore > 75 ? 'text-emerald-400' : cohort.healthScore > 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                          {cohort.healthScore}/100
                        </span>
                      </div>
                    </div>
                    <div className="h-2 w-full bg-zinc-900 rounded-full overflow-hidden border border-zinc-850">
                      <div 
                        className={`h-full rounded-full bg-gradient-to-r ${cohort.healthScore > 75 ? 'from-emerald-500 to-teal-500' : cohort.healthScore > 50 ? 'from-yellow-500 to-orange-500' : 'from-red-500 to-rose-500'}`}
                        style={{ width: `${Math.min(100, cohort.healthScore)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ─── Retention Diagnostic Stats ─── */}
        <div className="space-y-6">
          <Card className="bg-zinc-950/40 border-zinc-800/80">
            <CardHeader className="pb-3 border-b border-zinc-900">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Activity size={15} className="text-purple-400" />
                Retention Diagnostics
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <div className="grid grid-cols-3 gap-2">
                <MiniStat label="D1 Retention" value={`${metrics.retentionD1}%`} color="emerald" />
                <MiniStat label="D7 Retention" value={`${metrics.retentionD7}%`} color="teal" />
                <MiniStat label="D30 Retention" value={`${metrics.retentionD30}%`} color="blue" />
              </div>

              <div className="border-t border-zinc-900 pt-4 space-y-3.5">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-500 font-semibold">User Fatigue Risk (High)</span>
                    <span className="font-bold font-mono text-zinc-300">{metrics.fatigueIndicators.high}%</span>
                  </div>
                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                    <div className="h-full bg-red-500 rounded-full" style={{ width: `${metrics.fatigueIndicators.high}%` }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-500 font-semibold">Goal Completion Velocity</span>
                    <span className="font-bold font-mono text-zinc-300">Active</span>
                  </div>
                  <p className="text-[11px] text-zinc-500">Adaptive task pacer scale: dynamic.</p>
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-500 font-semibold">Economy Stability (Power XP Users)</span>
                    <span className="font-bold font-mono text-zinc-300">{metrics.xpDistribution.power}%</span>
                  </div>
                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${metrics.xpDistribution.power}%` }} />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

/* ─── TAB 2: BETA & COHORTS MANAGEMENT ─── */
interface BetaManagementTabProps {
  data: any;
  loading: boolean;
  inviteForm: any;
  setInviteForm: any;
  cohortForm: any;
  setCohortForm: any;
  generateInvite: any;
  createCohort: any;
}

const BetaManagementTab: React.FC<BetaManagementTabProps> = ({
  data,
  loading,
  inviteForm,
  setInviteForm,
  cohortForm,
  setCohortForm,
  generateInvite,
  createCohort,
}) => {
  if (loading) return <TabLoader />;
  if (!data?.success) return <TabError error="Could not load closed beta structures." />;

  const { stats } = data;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* ─── Invite Controls & Cohort Creators ─── */}
      <div className="space-y-6">
        {/* Generate Invite */}
        <Card className="bg-zinc-950/40 border-zinc-800/80">
          <CardHeader className="pb-3 border-b border-zinc-900">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Mail size={15} className="text-emerald-400" />
              Generate Beta Invite Code
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <form 
              onSubmit={(e) => {
                e.preventDefault();
                if (!inviteForm.email || !inviteForm.cohortId) return;
                generateInvite.mutate(inviteForm, {
                  onSuccess: () => setInviteForm({ email: '', cohortId: '' })
                });
              }}
              className="space-y-4"
            >
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Candidate Email</label>
                <input 
                  type="email" 
                  value={inviteForm.email}
                  onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                  placeholder="e.g. pilot@devtrack.io" 
                  required
                  className="w-full bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-3 py-2.5 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700 font-bold"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Assigned Cohort</label>
                <select 
                  value={inviteForm.cohortId}
                  onChange={(e) => setInviteForm({ ...inviteForm, cohortId: e.target.value })}
                  required
                  className="w-full bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-zinc-700 font-semibold"
                >
                  <option value="">Select a Cohort</option>
                  {stats.activeCohorts?.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                  ))}
                </select>
              </div>

              <Button 
                type="submit" 
                disabled={generateInvite.isPending}
                className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-xs rounded-xl"
              >
                {generateInvite.isPending ? 'Generating Code...' : 'Create Invite Link'}
              </Button>

              {generateInvite.isSuccess && (
                <div className="bg-zinc-900/60 border border-zinc-800 p-3 rounded-xl mt-3 space-y-1">
                  <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Generated Invite Code:</p>
                  <div className="flex items-center justify-between gap-2">
                    <code className="text-xs font-mono font-bold text-emerald-400 select-all">{generateInvite.data.invite.code}</code>
                    <Badge variant="success" className="text-[9px] px-1 py-0.5">Ready</Badge>
                  </div>
                </div>
              )}
            </form>
          </CardContent>
        </Card>

        {/* Create Cohort */}
        <Card className="bg-zinc-950/40 border-zinc-800/80">
          <CardHeader className="pb-3 border-b border-zinc-900">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Plus size={15} className="text-purple-400" />
              Spin Up Beta Cohort
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <form 
              onSubmit={(e) => {
                e.preventDefault();
                createCohort.mutate(cohortForm, {
                  onSuccess: () => setCohortForm({ name: '', description: '', type: 'alpha', targetSize: 50 })
                });
              }}
              className="space-y-4"
            >
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Cohort Identifier</label>
                <input 
                  type="text" 
                  value={cohortForm.name}
                  onChange={(e) => setCohortForm({ ...cohortForm, name: e.target.value })}
                  placeholder="e.g. Cohort Echo" 
                  required
                  className="w-full bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-3 py-2.5 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700 font-bold"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Description</label>
                <input 
                  type="text" 
                  value={cohortForm.description}
                  onChange={(e) => setCohortForm({ ...cohortForm, description: e.target.value })}
                  placeholder="e.g. Early tester group for pacer systems" 
                  className="w-full bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-3 py-2.5 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700 font-semibold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Type</label>
                  <select 
                    value={cohortForm.type}
                    onChange={(e) => setCohortForm({ ...cohortForm, type: e.target.value })}
                    className="w-full bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-zinc-700 font-semibold"
                  >
                    <option value="alpha">Alpha</option>
                    <option value="beta">Beta</option>
                    <option value="pilot">Pilot</option>
                    <option value="graduated">Graduated</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Target Size</label>
                  <input 
                    type="number" 
                    value={cohortForm.targetSize}
                    onChange={(e) => setCohortForm({ ...cohortForm, targetSize: parseInt(e.target.value) || 50 })}
                    required
                    className="w-full bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-zinc-700 font-mono font-bold"
                  />
                </div>
              </div>

              <Button 
                type="submit" 
                disabled={createCohort.isPending}
                className="w-full py-2.5 bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs rounded-xl"
              >
                {createCohort.isPending ? 'Provisioning Cohort...' : 'Initialize Cohort'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* ─── Cohorts Registry & Status ─── */}
      <div className="lg:col-span-2 space-y-6">
        {/* Cohort Stats Grid */}
        <div className="grid grid-cols-3 gap-4">
          <motion.div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-4">
            <p className="text-[10px] uppercase font-bold tracking-wider text-zinc-500">Total Beta Users</p>
            <p className="text-xl font-bold text-zinc-200 mt-1">{stats.totalBetaUsers || 0}</p>
          </motion.div>
          <motion.div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-4">
            <p className="text-[10px] uppercase font-bold tracking-wider text-zinc-500">Active Invites</p>
            <p className="text-xl font-bold text-zinc-200 mt-1">{stats.totalPendingInvites || 0}</p>
          </motion.div>
          <motion.div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-4">
            <p className="text-[10px] uppercase font-bold tracking-wider text-zinc-500">Total Feedback Loops</p>
            <p className="text-xl font-bold text-zinc-200 mt-1">{stats.totalFeedbackIssues || 0}</p>
          </motion.div>
        </div>

        {/* Cohorts Registry */}
        <Card className="bg-zinc-950/40 border-zinc-800/80">
          <CardHeader className="pb-3 border-b border-zinc-900">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Users size={15} className="text-zinc-400" />
              Closed Beta Cohorts Registry
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-900 text-zinc-500 font-bold">
                    <th className="py-2.5">Name</th>
                    <th className="py-2.5">Type</th>
                    <th className="py-2.5 text-center">Status</th>
                    <th className="py-2.5 text-right">Size / Target</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900/40">
                  {stats.activeCohorts?.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-zinc-500">No cohorts found. Register a new one.</td>
                    </tr>
                  ) : (
                    stats.activeCohorts?.map((cohort: any) => (
                      <tr key={cohort.id} className="hover:bg-zinc-900/10">
                        <td className="py-3.5">
                          <p className="font-bold text-zinc-200">{cohort.name}</p>
                          <p className="text-[10px] text-zinc-500 mt-0.5">{cohort.description}</p>
                        </td>
                        <td className="py-3.5">
                          <Badge variant="default" className="capitalize text-[10px] px-1.5 py-0">
                            {cohort.type}
                          </Badge>
                        </td>
                        <td className="py-3.5 text-center">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${cohort.status === 'active' ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600'}`} />
                          <span className="text-[10px] font-bold text-zinc-400 ml-1.5 capitalize">{cohort.status}</span>
                        </td>
                        <td className="py-3.5 text-right font-mono font-bold text-zinc-300">
                          {cohort.currentSize || 0} <span className="text-zinc-650">/</span> {cohort.targetSize || 50}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

/* ─── TAB 3: FEATURE GATES & ROLLOUTS ─── */
interface FeatureGatesTabProps {
  data: any;
  loading: boolean;
  toggleGate: any;
  configureGate: any;
}

const FeatureGatesTab: React.FC<FeatureGatesTabProps> = ({
  data,
  loading,
  toggleGate,
  configureGate,
}) => {
  const [editingGate, setEditingGate] = useState<string | null>(null);
  const [editingPercent, setEditingPercent] = useState<number>(0);

  if (loading) return <TabLoader />;
  if (!data?.success) return <TabError error="Could not load active feature gates." />;

  return (
    <Card className="bg-zinc-950/40 border-zinc-800/80">
      <CardHeader className="pb-3 border-b border-zinc-900">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <Sliders size={15} className="text-emerald-400" />
          Feature Release Gates & Rollouts
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <div className="space-y-4">
          {data.gates?.length === 0 ? (
            <div className="py-8 text-center text-zinc-500">No feature gates found.</div>
          ) : (
            data.gates?.map((gate: any) => (
              <div 
                key={gate.featureName} 
                className="bg-zinc-900/25 border border-zinc-900 hover:border-zinc-850 p-4 rounded-xl space-y-3 transition-all duration-200"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                      {gate.featureName}
                      <span className={`w-1.5 h-1.5 rounded-full ${gate.isEnabled ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    </h3>
                    <p className="text-[10px] text-zinc-500 mt-0.5 capitalize">Type: {gate.rules?.type || 'standard rollout'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button 
                      size="sm" 
                      variant="secondary" 
                      onClick={() => {
                        setEditingGate(gate.featureName);
                        setEditingPercent(gate.rolloutPercentage || 0);
                      }}
                      className="text-[10px] font-bold border-zinc-850 px-2.5 h-7"
                    >
                      Tune Gate
                    </Button>
                    <Button 
                      size="sm" 
                      variant={gate.isEnabled ? 'danger' : 'success'}
                      disabled={toggleGate.isPending}
                      onClick={() => toggleGate.mutate({ featureName: gate.featureName, enabled: !gate.isEnabled })}
                      className="text-[10px] font-bold px-3 h-7"
                    >
                      {gate.isEnabled ? 'Global Kill' : 'Global Enable'}
                    </Button>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-zinc-500 font-bold bg-zinc-950/20 px-3 py-1.5 rounded-lg border border-zinc-900/60">
                  <div className="flex items-center gap-2">
                    <Percent size={12} className="text-zinc-600" />
                    <span>Graduated Rollout Threshold:</span>
                  </div>
                  <span className="font-mono text-zinc-300">{gate.rolloutPercentage || 0}% of users</span>
                </div>

                {/* Rollout slider overlay */}
                {editingGate === gate.featureName && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="border-t border-zinc-900/80 pt-3 mt-2 space-y-3"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-[11px] font-bold text-zinc-500">Rollout Level</span>
                      <span className="text-xs font-mono font-bold text-emerald-400">{editingPercent}%</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <input 
                        type="range" 
                        min="0" 
                        max="100" 
                        value={editingPercent}
                        onChange={(e) => setEditingPercent(parseInt(e.target.value) || 0)}
                        className="flex-1 accent-emerald-500"
                      />
                      <Button 
                        size="sm" 
                        disabled={configureGate.isPending}
                        onClick={() => {
                          configureGate.mutate({
                            featureName: gate.featureName,
                            rolloutPercentage: editingPercent,
                          }, {
                            onSuccess: () => setEditingGate(null)
                          });
                        }}
                        className="h-7 text-[10px] font-bold bg-emerald-500 hover:bg-emerald-600 text-white"
                      >
                        Apply Rollout
                      </Button>
                      <Button 
                        size="sm" 
                        variant="secondary"
                        onClick={() => setEditingGate(null)}
                        className="h-7 text-[10px] font-bold border-zinc-850"
                      >
                        Cancel
                      </Button>
                    </div>
                  </motion.div>
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
};

/* ─── TAB 4: KILL SWITCHES & SAFETY CONTROLS ─── */
interface KillSwitchesTabProps {
  data: any;
  loading: boolean;
  toggleSwitch: any;
  switchReason: Record<string, string>;
  setSwitchReason: any;
}

const KillSwitchesTab: React.FC<KillSwitchesTabProps> = ({
  data,
  loading,
  toggleSwitch,
  switchReason,
  setSwitchReason,
}) => {
  if (loading) return <TabLoader />;
  if (!data?.success) return <TabError error="Could not load global pacing kill switches." />;

  const isEmergency = data.switches?.some((s: any) => s.state === 'disabled');

  return (
    <div className="space-y-6">
      {/* ─── Big Red Emergency Box ─── */}
      <Card className={`border-2 ${isEmergency ? 'border-red-500 bg-red-950/15' : 'border-zinc-800 bg-zinc-950/40'}`}>
        <CardContent className="pt-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="space-y-1.5 text-center md:text-left">
            <h2 className="text-base font-bold text-zinc-100 flex items-center justify-center md:justify-start gap-2">
              <XOctagon className={isEmergency ? 'text-red-500 animate-pulse' : 'text-zinc-500'} size={18} />
              Global Safety Control Center
            </h2>
            <p className="text-xs text-zinc-500 max-w-xl">
              Operator safety console. Activating a kill switch instantly suppresses behavioral triggers, notification dispatching, or adaptive progress pacing pipelines globally.
            </p>
          </div>
          {isEmergency && (
            <Badge variant="error" className="animate-pulse uppercase tracking-wider text-xs px-3 py-1 font-bold">
              Systems Suppressed
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* ─── Individual Kill Switches ─── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.switches?.map((s: any) => (
          <Card key={s.id} className="bg-zinc-950/40 border-zinc-800/80">
            <CardContent className="pt-4 flex flex-col justify-between h-full gap-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-xs font-bold text-zinc-200 tracking-tight">{s.name}</h3>
                  <p className="text-[11px] text-zinc-500 mt-1">{s.description}</p>
                </div>
                <Badge variant={s.state === 'active' ? 'success' : 'error'} className="text-[9px] uppercase px-1.5">
                  {s.state}
                </Badge>
              </div>

              {s.state !== 'active' && s.reason && (
                <div className="bg-zinc-900/40 border border-zinc-850 p-2.5 rounded-lg">
                  <p className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Reason for Shutdown:</p>
                  <p className="text-[10px] text-red-400 mt-0.5 font-semibold font-mono">"{s.reason}"</p>
                  <p className="text-[9px] text-zinc-650 mt-1 font-bold">BY: {s.activatedBy || 'System'}</p>
                </div>
              )}

              <div className="flex items-center gap-3">
                <input 
                  type="text"
                  placeholder="Shutdown reason Required..."
                  value={switchReason[s.id] || ''}
                  onChange={(e) => setSwitchReason({ ...switchReason, [s.id]: e.target.value })}
                  disabled={s.state !== 'active'}
                  className="flex-1 bg-zinc-900/60 border border-zinc-850 rounded-lg px-2.5 py-1.5 text-[10px] text-white focus:outline-none focus:border-zinc-700 disabled:opacity-40 font-semibold"
                />
                <Button
                  size="sm"
                  variant={s.state === 'active' ? 'danger' : 'success'}
                  disabled={toggleSwitch.isPending || (s.state === 'active' && !switchReason[s.id])}
                  onClick={() => {
                    toggleSwitch.mutate({
                      switchId: s.id,
                      enabled: s.state !== 'active',
                      reason: switchReason[s.id] || 'Operator Override',
                    }, {
                      onSuccess: () => setSwitchReason({ ...switchReason, [s.id]: '' })
                    });
                  }}
                  className="h-8 text-[10px] font-bold px-3 shrink-0"
                >
                  {s.state === 'active' ? 'Force Stop' : 'Restore System'}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};

/* ─── TAB 5: SYSTEM HEALTH & DIAGNOSTICS ─── */
interface SystemTabProps {
  metrics: any;
  loading: boolean;
  telemetry: any[];
  sseStatus: string;
  connectionStatus: string;
}

const SystemTab: React.FC<SystemTabProps> = ({
  metrics,
  loading,
  telemetry,
  sseStatus,
  connectionStatus,
}) => {
  const queryClient = useQueryClient();
  const [retryingQueue, setRetryingQueue] = useState<string | null>(null);

  const handleRetryQueue = async (queueName: string) => {
    try {
      setRetryingQueue(queueName);
      await axiosClient.post(`/ops/queues/${queueName}/replay-all`);
      await queryClient.invalidateQueries({ queryKey: ['ops-metrics'] });
    } catch (e) {
      console.error('Failed to retry queue jobs', e);
    } finally {
      setRetryingQueue(null);
    }
  };

  if (loading) return <TabLoader />;

  const queueData = metrics?.queues || [];
  const workerData = metrics?.workers?.xp || {};
  const sseData = metrics?.sse || {};
  const aiLatency = metrics?.aiLatency || { gemini: 0, openai: 0 };

  return (
    <div className="space-y-6">
      {/* Real-time Diagnostics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* AI Provider Latency */}
        <Card className="bg-zinc-950/40 border-zinc-800/80">
          <CardHeader className="pb-3 border-b border-zinc-900">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Zap size={15} className="text-emerald-400" />
              AI Latencies (Avg)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">Gemini 1.5 Pro:</span>
              <span className="font-bold text-emerald-400 font-mono">{aiLatency.gemini || 'N/A'} ms</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">OpenAI GPT-4o:</span>
              <span className="font-bold text-blue-400 font-mono">{aiLatency.openai || 'N/A'} ms</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Active Routing:</span>
              <Badge variant="success" className="px-1.5 py-0 text-[10px]">Deterministic</Badge>
            </div>
          </CardContent>
        </Card>

        {/* SSE State */}
        <Card className="bg-zinc-950/40 border-zinc-800/80">
          <CardHeader className="pb-3 border-b border-zinc-900">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Radio size={15} className="text-teal-400" />
              Real-time SSE Status
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">SSE Hook:</span>
              <span className="font-bold text-zinc-300 capitalize">{sseStatus}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">SSE Store:</span>
              <span className="font-bold text-zinc-300 capitalize">{connectionStatus}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Active Connections:</span>
              <span className="font-bold text-zinc-300 font-mono">{sseData.activeConnections || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Total Dispatch Events:</span>
              <span className="font-bold text-zinc-300 font-mono">{sseData.eventsPublished || 0}</span>
            </div>
          </CardContent>
        </Card>

        {/* Worker Diagnostics */}
        <Card className="bg-zinc-950/40 border-zinc-800/80">
          <CardHeader className="pb-3 border-b border-zinc-900">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Zap size={15} className="text-yellow-400" />
              XP Pacing Workers
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">XP Processor:</span>
              <Badge variant={workerData.running ? 'success' : 'warning'} className="px-1.5">
                {workerData.running ? 'Running' : 'Stopped'}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Processed Jobs:</span>
              <span className="font-bold text-zinc-300 font-mono">{workerData.processed || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Awarded Events:</span>
              <span className="font-bold text-zinc-300 font-mono">{workerData.awarded || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Deduped Duplicates:</span>
              <span className="font-bold text-zinc-300 font-mono text-emerald-400">{workerData.duplicates || 0}</span>
            </div>
          </CardContent>
        </Card>

        {/* Queue Statuses */}
        <Card className="bg-zinc-950/40 border-zinc-800/80">
          <CardHeader className="pb-3 border-b border-zinc-900">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Server size={15} className="text-purple-400" />
              Queue Monitors
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3.5">
            {queueData.length === 0 ? (
              <p className="text-xs text-zinc-500 text-center py-4">No job queues registered.</p>
            ) : (
              queueData.map((q: any) => (
                <div key={q.name} className="space-y-1.5 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-zinc-400 font-mono truncate mr-2">{q.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500 shrink-0 font-mono">
                        [W: {q.waiting} | A: {q.active} | F: {q.failed}]
                      </span>
                      {q.failed > 0 && (
                        <button
                          onClick={() => handleRetryQueue(q.name)}
                          disabled={retryingQueue === q.name}
                          className="px-1.5 py-0.5 rounded text-[10px] bg-red-950/60 hover:bg-red-900/60 text-red-300 border border-red-800/60 transition flex items-center gap-1 font-mono cursor-pointer"
                          title="Retry all failed jobs in DLQ"
                        >
                          <RefreshCw size={10} className={retryingQueue === q.name ? "animate-spin" : ""} />
                          Retry
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden flex">
                    <div className="bg-emerald-500 h-full" style={{ width: `${Math.min(100, (q.completed / (q.completed + q.failed || 1)) * 100)}%` }} />
                    <div className="bg-red-500 h-full" style={{ width: `${Math.min(100, (q.failed / (q.completed + q.failed || 1)) * 100)}%` }} />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Telemetry Logger */}
      <Card className="bg-zinc-950/40 border-zinc-800/80">
        <CardHeader className="pb-3 border-b border-zinc-900">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Activity size={15} className="text-zinc-400" />
            Client Telemetry Buffer
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <ul className="space-y-2 text-xs font-mono text-zinc-500 max-h-64 overflow-y-auto">
            {telemetry.length === 0 ? (
              <li className="text-center py-4">No operational events buffered.</li>
            ) : (
              telemetry.map((e: any, i: number) => (
                <li key={i} className="flex gap-2 p-1.5 hover:bg-zinc-900/20 rounded">
                  <span className="text-zinc-650 shrink-0">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className="text-zinc-400 font-bold shrink-0">[{e.name}]</span>
                  <span className="text-zinc-500 truncate">{JSON.stringify(e.data || {})}</span>
                </li>
              ))
            )}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};

  // ─── UTILS & SMALL SUB-COMPONENTS ─── */
const TabLoader = () => (
  <div className="flex flex-col items-center justify-center py-24 text-center">
    <RefreshCw size={24} className="text-zinc-650 animate-spin mb-3" />
    <p className="text-xs text-zinc-500 font-bold tracking-widest uppercase">Fetching Diagnostics...</p>
  </div>
);

const TabError = ({ error }: { error: string }) => (
  <div className="flex items-start gap-3 rounded-xl bg-red-950/15 border border-red-900 p-4 max-w-xl mx-auto">
    <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={16} />
    <div>
      <p className="text-xs font-bold text-red-400">Connection Interruption</p>
      <p className="text-[11px] text-zinc-500 mt-0.5">{error}</p>
    </div>
  </div>
);

/* ─── TAB: CACHE HEALTH ─── */
const CacheHealthTab = () => {
  const { data, isLoading } = useQuery({
    queryKey: ['ops-cache-health'],
    queryFn: async () => {
      const { data } = await axiosClient.get('/ops/public/cache-health');
      return data;
    },
    refetchInterval: 10000,
  });

  if (isLoading) return <TabLoader />;
  if (!data) return <TabError error="Could not load cache diagnostics." />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <HealthMetricCard label="Redis State" value={data.status} status={data.status === 'healthy' ? 'healthy' : 'critical'} />
        <HealthMetricCard label="Total Keys" value={data.keys.toString()} status="healthy" />
        <HealthMetricCard label="Public Profiles" value={data.publicProfileKeys.toString()} status="healthy" />
        <HealthMetricCard label="Memory Used" value={data.memoryUsed} status="healthy" />
      </div>

      <Card className="bg-zinc-950/40 border-zinc-800/80">
        <CardHeader className="pb-3 border-b border-zinc-900">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Server size={15} className="text-emerald-400" />
            Cache Diagnostics (L2 Public API)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3 text-xs">
          <div className="flex justify-between border-b border-zinc-900 pb-2">
            <span className="text-zinc-500">Uptime:</span>
            <span className="font-bold text-zinc-300 font-mono">{data.uptime} seconds</span>
          </div>
          <div className="flex justify-between border-b border-zinc-900 pb-2">
            <span className="text-zinc-500">Connected Clients:</span>
            <span className="font-bold text-zinc-300 font-mono">{data.connectedClients}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Memory Fragmentation:</span>
            <span className="font-bold text-zinc-300 font-mono">{data.memoryFragmentationRatio}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

/* ─── TAB: TRUST SCORES ─── */
const TrustScoresTab = () => {
  const { data, isLoading } = useQuery({
    queryKey: ['ops-trust-scores'],
    queryFn: async () => {
      const { data } = await axiosClient.get('/ops/trust/scores');
      return data;
    },
    refetchInterval: 15000,
  });

  if (isLoading) return <TabLoader />;
  if (!data) return <TabError error="Could not load trust scores." />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <HealthMetricCard label="Total Monitored Profiles" value={data.aggregates?.totalProfiles?.toString() || '0'} status="healthy" />
        <HealthMetricCard label="Low Trust Profiles (<400)" value={data.aggregates?.lowTrustProfiles?.toString() || '0'} status={data.aggregates?.lowTrustProfiles > 0 ? 'warning' : 'healthy'} />
      </div>

      <Card className="bg-zinc-950/40 border-zinc-800/80">
        <CardHeader className="pb-3 border-b border-zinc-900">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Shield size={15} className="text-purple-400" />
            Active Trust Profiles
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b border-zinc-900 text-zinc-500 font-bold">
                <th className="py-2.5">User</th>
                <th className="py-2.5">Trust Score</th>
                <th className="py-2.5">Status</th>
                <th className="py-2.5">Last Verified</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900/40">
              {data.profiles?.map((p: any) => (
                <tr key={p.userId} className="hover:bg-zinc-900/10">
                  <td className="py-3.5 font-bold text-zinc-200">{p.username}</td>
                  <td className="py-3.5 font-mono text-zinc-300">
                    <span className={p.verification?.trustScore < 400 ? 'text-red-400' : 'text-emerald-400'}>
                      {p.verification?.trustScore || 0}
                    </span>
                  </td>
                  <td className="py-3.5">
                    <Badge variant={p.verification?.isVerified ? 'success' : 'default'} className="text-[10px] uppercase px-1.5 py-0">
                      {p.verification?.isVerified ? 'Verified' : 'Pending'}
                    </Badge>
                  </td>
                  <td className="py-3.5 text-zinc-500 font-mono">{new Date(p.verification?.lastVerifiedAt || p.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
};

/* ─── TAB: VERIFICATION AUDITS ─── */
const VerificationAuditsTab = () => {
  const { data, isLoading } = useQuery({
    queryKey: ['ops-verification-audits'],
    queryFn: async () => {
      const { data } = await axiosClient.get('/ops/trust/verifications');
      return data;
    },
    refetchInterval: 15000,
  });

  if (isLoading) return <TabLoader />;
  if (!data) return <TabError error="Could not load verification audit logs." />;

  return (
    <Card className="bg-zinc-950/40 border-zinc-800/80">
      <CardHeader className="pb-3 border-b border-zinc-900">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <CheckCircle size={15} className="text-emerald-400" />
          Verification Audit Trail
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 overflow-x-auto">
        <table className="w-full text-xs text-left border-collapse">
          <thead>
            <tr className="border-b border-zinc-900 text-zinc-500 font-bold">
              <th className="py-2.5">Time</th>
              <th className="py-2.5">User ID</th>
              <th className="py-2.5">Action</th>
              <th className="py-2.5">Score Change</th>
              <th className="py-2.5">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900/40">
            {data.logs?.map((log: any) => (
              <tr key={log._id} className="hover:bg-zinc-900/10">
                <td className="py-3.5 text-zinc-500 font-mono whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</td>
                <td className="py-3.5 font-mono text-zinc-300">{log.userId}</td>
                <td className="py-3.5">
                  <Badge variant="default" className="text-[9px] uppercase px-1.5 py-0">
                    {log.action}
                  </Badge>
                </td>
                <td className="py-3.5 font-mono">
                  {log.previousScore !== log.newScore ? (
                    <span className={log.newScore < log.previousScore ? 'text-red-400' : 'text-emerald-400'}>
                      {log.previousScore} → {log.newScore}
                    </span>
                  ) : (
                    <span className="text-zinc-600">No Change</span>
                  )}
                </td>
                <td className="py-3.5 text-zinc-400 truncate max-w-[250px]" title={log.reason}>{log.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
};

/* ─── TAB: MANUAL OVERRIDES ─── */
const ManualOverridesTab = () => {
  const [modalState, setModalState] = useState<{ isOpen: boolean; action: string; title: string; desc: string } | null>(null);
  
  const handleAction = async () => {
    if (!modalState) return;
    try {
      if (modalState.action === 'rebuild-all') await axiosClient.post('/ops/recovery/rebuild-all');
      if (modalState.action === 'invalidate-cache') await axiosClient.post('/ops/recovery/invalidate-cache');
      // recalc-trust would need an input for userId, omit for simplicity or hardcode for demo
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="border-2 border-red-900/50 bg-red-950/10">
        <CardHeader className="pb-3 border-b border-red-900/30">
          <CardTitle className="text-sm font-bold flex items-center gap-2 text-red-500">
            <AlertTriangle size={15} />
            Destructive Recovery Operations
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center justify-between p-4 bg-zinc-950/50 border border-zinc-900 rounded-xl">
            <div>
              <p className="text-xs font-bold text-zinc-200">Global Profile Rebuild</p>
              <p className="text-[10px] text-zinc-500 mt-1">Enqueues all profiles for a full snapshot recreation via BullMQ.</p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setModalState({ isOpen: true, action: 'rebuild-all', title: 'Global Profile Rebuild', desc: 'This will enqueue thousands of jobs and may impact database performance.' })}>
              Rebuild All
            </Button>
          </div>

          <div className="flex items-center justify-between p-4 bg-zinc-950/50 border border-zinc-900 rounded-xl">
            <div>
              <p className="text-xs font-bold text-zinc-200">Invalidate L2 Cache</p>
              <p className="text-[10px] text-zinc-500 mt-1">Purges all public_profile:* keys from Redis, forcing immediate read-throughs.</p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setModalState({ isOpen: true, action: 'invalidate-cache', title: 'Invalidate L2 Cache', desc: 'This will cause a spike in database reads as public profiles are re-cached.' })}>
              Invalidate Cache
            </Button>
          </div>
        </CardContent>
      </Card>

      {modalState?.isOpen && (
        <DestructiveActionModal
          title={modalState.title}
          description={modalState.desc}
          onConfirm={() => {
            handleAction();
            setModalState(null);
          }}
          onCancel={() => setModalState(null)}
        />
      )}
    </div>
  );
};

const DestructiveActionModal = ({ title, description, onConfirm, onCancel }: { title: string, description: string, onConfirm: () => void, onCancel: () => void }) => {
  const [confirmText, setConfirmText] = useState('');
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-zinc-950 border border-red-900/50 rounded-2xl shadow-2xl overflow-hidden"
      >
        <div className="p-5 border-b border-zinc-900">
          <h3 className="text-lg font-bold text-red-500 flex items-center gap-2">
            <AlertTriangle size={18} />
            Confirm Destructive Action
          </h3>
          <p className="text-xs text-zinc-400 mt-2">{description}</p>
        </div>
        
        <div className="p-5 space-y-4 bg-zinc-900/30">
          <div className="space-y-2">
            <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
              Type <span className="text-zinc-200 font-mono select-all px-1 bg-zinc-800 rounded">{title}</span> to confirm
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={`Type "${title}"`}
              className="w-full bg-zinc-900/60 border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-red-900/50 font-mono"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 p-5 border-t border-zinc-900 bg-zinc-950">
          <Button variant="secondary" className="flex-1" onClick={onCancel}>Cancel</Button>
          <Button 
            variant="danger" 
            className="flex-1"
            disabled={confirmText !== title}
            onClick={onConfirm}
          >
            Execute Action
          </Button>
        </div>
      </motion.div>
    </div>
  );
};

interface HealthMetricCardProps {
  label: string;
  value: string;
  status: 'healthy' | 'warning' | 'critical';
}

const HealthMetricCard: React.FC<HealthMetricCardProps> = ({ label, value, status }) => {
  return (
    <motion.div
      layout
      className="rounded-xl border border-zinc-800/80 bg-zinc-950/30 p-4 relative overflow-hidden"
    >
      <p className="text-[9px] uppercase font-bold tracking-wider text-zinc-500">{label}</p>
      <p className="text-xl font-bold text-zinc-100 mt-1 capitalize">{value}</p>
      <div 
        className={`absolute bottom-0 left-0 right-0 h-[2px] 
          ${status === 'healthy' ? 'bg-emerald-500' : status === 'warning' ? 'bg-yellow-500' : 'bg-red-500'}
        `} 
      />
    </motion.div>
  );
};

interface MiniStatProps {
  label: string;
  value: string;
  color: 'emerald' | 'teal' | 'blue' | 'indigo' | 'purple';
}

const MiniStat: React.FC<MiniStatProps> = ({ label, value, color }) => {
  const colorMap = {
    emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/15',
    teal: 'bg-teal-500/10 text-teal-400 border-teal-500/15',
    blue: 'bg-blue-500/10 text-blue-400 border-blue-500/15',
    indigo: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/15',
    purple: 'bg-purple-500/10 text-purple-400 border-purple-500/15',
  };

  return (
    <div className={`p-2.5 rounded-xl border text-center ${colorMap[color]}`}>
      <p className="text-[9px] font-bold uppercase tracking-wider opacity-75">{label}</p>
      <p className="text-base font-bold font-mono mt-0.5">{value}</p>
    </div>
  );
};

export default AdminPage;
