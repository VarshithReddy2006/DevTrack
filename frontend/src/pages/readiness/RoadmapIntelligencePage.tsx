import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Link, useInRouterContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Briefcase,
  CheckCircle,
  Clock,
  FolderPlus,
  Layers,
  Map as MapIcon,
  MessageSquare,
  PlayCircle,
  RefreshCcw,
  Search,
  Sparkles,
  Star,
  Target,
  Zap,
} from 'lucide-react';
import { useReadinessDomain } from '../../features/readiness/hooks/useReadinessData';
import { WorkspaceHeader } from '../../features/readiness/components/WorkspaceHeader';
import { RoadmapMilestoneTimeline } from '../../features/readiness/components/RoadmapMilestoneTimeline';
import { CrashCourseWorkspace } from '../../features/readiness/components/CrashCourseWorkspace';
import type { RoadmapTaskToggle } from '../../features/readiness/components/roadmapTimeline.types';
import {
  mapMilestoneRoadmapToTimeline,
  readinessService,
  type CrashCoursePlan,
  type CrashCourseWindow,
  type LearningResource,
  type MilestoneRoadmapApiResponse,
  type ReadinessRoadmapDomainResponse,
  type VerifiedSkillSource,
} from '../../services/readinessService';
import { listJobTargets } from '../../services/jobTargetsService';
type JobTargetSummary = Awaited<ReturnType<typeof listJobTargets>>[number];
import { useFeatureFlags } from '../../features/flags/hooks/useFeatureFlags';
import { INTERVIEW_STUDIO_FLAG, INTERVIEW_STUDIO_PATH } from '../../features/interview/interview';
import { EmptyState } from '../../components/shared/EmptyState';
import { analyticsService } from '../../services/analyticsService';

const ROLE_SKILLS_CATALOG: Record<string, string[]> = {
  'Backend Developer': ['Node.js', 'Express', 'MongoDB', 'SQL', 'Docker', 'Redis', 'Testing', 'CI/CD', 'System Design', 'Authentication', 'Caching'],
  'Frontend Developer': ['React', 'JavaScript', 'TypeScript', 'CSS', 'HTML', 'Tailwind CSS', 'Next.js', 'Redux', 'Webpack', 'Testing', 'Accessibility'],
  'Full Stack Developer': ['React', 'Node.js', 'Express', 'MongoDB', 'SQL', 'TypeScript', 'Docker', 'Redis', 'Testing', 'CI/CD', 'HTML', 'CSS', 'Tailwind CSS'],
  'DevOps Engineer': ['Docker', 'Kubernetes', 'CI/CD', 'Jenkins', 'GitHub Actions', 'AWS', 'GCP', 'Prometheus', 'Grafana', 'Terraform', 'Linux'],
  'AI Engineer': ['Python', 'PyTorch', 'TensorFlow', 'Machine Learning', 'Deep Learning', 'NLP', 'LLMs', 'Vector Databases', 'OpenAI', 'Data Pipelines'],
  'Data Analyst': ['SQL', 'Python', 'Pandas', 'NumPy', 'Tableau', 'Power BI', 'Excel', 'Data Visualization', 'Statistics', 'Data Cleaning'],
  'Mobile Developer': ['React Native', 'Flutter', 'Swift', 'Kotlin', 'iOS', 'Android', 'Mobile Design', 'API Integration', 'Testing', 'App Store Deployment'],
};

const SOURCE_LABELS: Record<VerifiedSkillSource['source'], string> = {
  github: 'Verified · GitHub',
  resume: 'Verified · Resume',
  project: 'Verified · Project',
  self: 'Self-marked',
};

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  docs: 'Docs',
  course: 'Course',
  video: 'Video',
  article: 'Article',
};

const RESOURCE_DONE_STORAGE_KEY = 'devtrack:roadmap:resource-done';

function loadDoneResources(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(RESOURCE_DONE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveDoneResources(next: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(RESOURCE_DONE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota / restricted context errors
  }
}

function roleToSlug(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ─── Progress Ring ───
const ProgressRing: React.FC<{ percent: number; size?: number }> = ({ percent, size = 120 }) => {
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;

  return (
    <div className="relative text-emerald-500" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeWidth={strokeWidth}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ delay: 0.15, duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
          className="drop-shadow-[0_0_8px_rgba(16,185,129,0.5)]"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-black text-slate-800 tracking-tighter tabular-nums">{percent}%</span>
        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-0.5">Progress</span>
      </div>
    </div>
  );
};

interface CareerDiscoveryInitialValues {
  targetRole?: string;
  goal?: string;
  experienceLevel?: string;
  weeklyHours?: number;
  targetDeadlineWeeks?: number;
  knownSkills?: string[];
}

const CareerDiscoveryForm: React.FC<{
  initialValues?: CareerDiscoveryInitialValues;
  onComplete: (result?: { paceMode?: 'standard' | 'crash'; crashWindow?: CrashCourseWindow }) => void;
  onCancel?: () => void;
}> = ({ initialValues, onComplete, onCancel }) => {
  const [trackMode, setTrackMode] = useState<'role' | 'jobTarget'>('role');
  const [targetRole, setTargetRole] = useState(initialValues?.targetRole || 'Backend Developer');
  const [selectedJobTargetId, setSelectedJobTargetId] = useState('');
  const [goal, setGoal] = useState(initialValues?.goal || 'First Job');
  const [experienceLevel, setExperienceLevel] = useState(initialValues?.experienceLevel || 'Beginner');
  const [weeklyHours, setWeeklyHours] = useState<number>(initialValues?.weeklyHours || 10);
  const [targetDeadlineWeeks, setTargetDeadlineWeeks] = useState<number>(initialValues?.targetDeadlineWeeks || 12);
  const [paceMode, setPaceMode] = useState<'standard' | 'crash'>('standard');
  const [crashWindow, setCrashWindow] = useState<CrashCourseWindow>('7d');
  const [knownSkills, setKnownSkills] = useState<string[]>(initialValues?.knownSkills ?? []);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data: jobTargets = [] } = useQuery<JobTargetSummary[]>({
    queryKey: ['jobTargetsForRoadmap'],
    queryFn: ({ signal }) => listJobTargets(signal).catch(() => []),
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (trackMode === 'jobTarget' && jobTargets.length > 0 && !selectedJobTargetId) {
      setSelectedJobTargetId(jobTargets[0].id);
    }
  }, [trackMode, jobTargets, selectedJobTargetId]);

  const roleSkills = ROLE_SKILLS_CATALOG[targetRole] ?? ROLE_SKILLS_CATALOG['Backend Developer'];

  const toggleKnownSkill = (skill: string) => {
    setKnownSkills((prev) =>
      prev.includes(skill) ? prev.filter((item) => item !== skill) : [...prev, skill]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const selectedTarget = trackMode === 'jobTarget'
        ? jobTargets.find((jt) => jt.id === selectedJobTargetId)
        : undefined;
      const effectiveRole = selectedTarget?.role || targetRole;
      const res = await readinessService.setIntent({
        dreamRole: effectiveRole,
        goal,
        experienceLevel,
        weeklyHours,
        targetDeadlineWeeks: paceMode === 'crash' ? 2 : targetDeadlineWeeks,
        knownSkills: knownSkills.length > 0 ? knownSkills : undefined,
        jobTargetId: selectedTarget?.id,
      });
      if (res.success) {
        analyticsService.trackEvent('career_discovery_completed', {
          targetRole: effectiveRole,
          weeklyHours,
          targetDeadlineWeeks: paceMode === 'crash' ? 2 : targetDeadlineWeeks,
        });
        onComplete({ paceMode, crashWindow });
      } else {
        setSubmitError('Failed to generate career roadmap. Please try again.');
      }
    } catch {
      setSubmitError('An error occurred. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-2xl mx-auto bg-white border border-slate-200/80 rounded-2xl p-6 md:p-8 shadow-xs mt-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h3 className="text-xl font-bold text-slate-900 tracking-tight">Career Discovery</h3>
          <p className="text-sm text-slate-500 mt-1">
            Configure your target role, pace, and known skills to calibrate your milestone roadmap.
          </p>
        </div>
        {jobTargets.length > 0 && (
          <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() => setTrackMode('role')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                trackMode === 'role' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Role Track
            </button>
            <button
              type="button"
              onClick={() => setTrackMode('jobTarget')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                trackMode === 'jobTarget' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Briefcase size={12} />
              Saved Job Target ({jobTargets.length})
            </button>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {trackMode === 'jobTarget' && jobTargets.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Saved Job Target</label>
              <select
                value={selectedJobTargetId}
                onChange={(e) => setSelectedJobTargetId(e.target.value)}
                className="w-full bg-slate-50/70 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {jobTargets.map((jt) => (
                  <option key={jt.id} value={jt.id}>
                    {jt.role || 'Job Target'}{jt.company ? ` @ ${jt.company}` : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Target Role</label>
              <select
                value={targetRole}
                onChange={(e) => setTargetRole(e.target.value)}
                className="w-full bg-slate-50/70 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {Object.keys(ROLE_SKILLS_CATALOG).map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Primary Goal</label>
            <select
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className="w-full bg-slate-50/70 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="Internship">Internship</option>
              <option value="First Job">First Job</option>
              <option value="Job Switch">Job Switch</option>
              <option value="Promotion">Promotion</option>
              <option value="Freelancing">Freelancing</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Experience Level</span>
            <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-slate-200 bg-slate-50 p-1">
              {['Beginner', 'Intermediate', 'Advanced'].map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => setExperienceLevel(level)}
                  className={`py-2 px-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    experienceLevel === level
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Weekly Commitment</span>
            <div className="grid grid-cols-4 gap-1.5 rounded-xl border border-slate-200 bg-slate-50 p-1">
              {[
                { label: '5h', value: 5 },
                { label: '10h', value: 10 },
                { label: '15h', value: 15 },
                { label: '20h+', value: 20 },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setWeeklyHours(opt.value)}
                  className={`py-2 px-2 rounded-lg text-xs font-semibold transition-colors tabular-nums whitespace-nowrap ${
                    weeklyHours === opt.value
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Pace Mode & Timeline</span>
            <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
              <button
                type="button"
                onClick={() => setPaceMode('standard')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  paceMode === 'standard' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Standard Roadmap
              </button>
              <button
                type="button"
                onClick={() => setPaceMode('crash')}
                className={`inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  paceMode === 'crash' ? 'bg-amber-500 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Zap size={11} />
                Crash Course Blitz
              </button>
            </div>
          </div>
          {paceMode === 'standard' ? (
            <div className="grid grid-cols-4 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-1">
              {[4, 8, 12, 20].map((wks) => (
                <button
                  key={wks}
                  type="button"
                  onClick={() => setTargetDeadlineWeeks(wks)}
                  className={`py-2 px-3 rounded-lg text-xs font-semibold transition-colors tabular-nums whitespace-nowrap cursor-pointer ${
                    targetDeadlineWeeks === wks
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {wks} wks
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-1">
              {(
                [
                  { id: '48h', label: '48-Hour Blitz' },
                  { id: '7d', label: '7-Day Intensive' },
                  { id: '14d', label: '14-Day Sprint' },
                ] as const
              ).map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setCrashWindow(preset.id)}
                  className={`py-2 px-3 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    crashWindow === preset.id
                      ? 'bg-amber-600 text-white shadow-xs'
                      : 'text-amber-800 hover:bg-amber-100/70'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {trackMode === 'role' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                Skills You Already Know <span className="font-medium normal-case text-slate-400">(optional)</span>
              </span>
              {knownSkills.length > 0 && (
                <span className="text-xs font-semibold text-emerald-700 tabular-nums">
                  {knownSkills.length} selected
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200/80 bg-slate-50/50 p-3">
              {roleSkills.map((skill) => {
                const active = knownSkills.includes(skill);
                return (
                  <button
                    key={skill}
                    type="button"
                    onClick={() => toggleKnownSkill(skill)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors cursor-pointer ${
                      active
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:text-slate-900'
                    }`}
                  >
                    {active && <CheckCircle size={12} className="shrink-0" />}
                    {skill}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {submitError && (
          <p className="text-xs font-semibold text-rose-500 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" /> {submitError}
          </p>
        )}

        <div className="flex flex-wrap gap-3 pt-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="py-2.5 px-5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold rounded-xl transition-colors text-sm whitespace-nowrap"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex-1 py-2.5 px-6 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-semibold rounded-xl shadow-xs transition-colors text-sm whitespace-nowrap"
          >
            {isSubmitting ? 'Generating Roadmap...' : 'Generate Personalized Roadmap'}
          </button>
        </div>
      </form>
    </motion.div>
  );
};

const FeedbackWidget: React.FC = () => {
  const [rating, setRating] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (submitted) {
    return (
      <div className="px-5 py-3.5 bg-emerald-50 rounded-2xl border border-emerald-200 flex items-center justify-center text-xs font-semibold text-emerald-800">
        Thank you for your feedback! It helps us improve DevTrack.
      </div>
    );
  }

  const handleSubmit = async () => {
    if (!rating) return;
    setIsSubmitting(true);
    try {
      await analyticsService.submitFeedback(rating, feedback, 'roadmap');
      setSubmitted(true);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white px-5 py-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-semibold text-slate-700">Was this roadmap helpful?</span>
        <div className="flex flex-wrap items-center gap-2">
          {[
            { icon: '👍', label: 'Yes' },
            { icon: '🙂', label: 'Somewhat' },
            { icon: '👎', label: 'Needs Work' },
          ].map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => setRating(r.icon)}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                rating === r.icon
                  ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 bg-slate-50/60 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>{r.icon}</span>
              <span>{r.label}</span>
            </button>
          ))}
        </div>
      </div>

      {rating && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="mt-4 pt-4 border-t border-slate-100 space-y-3"
        >
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none min-h-[84px]"
            placeholder="Tell us what you liked or what is missing..."
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap"
            >
              {isSubmitting ? 'Submitting...' : 'Submit Feedback'}
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
};

type SkillFilterTab = 'all' | 'priority' | 'remaining' | 'completed';

const RoadmapIntelligencePage: React.FC = () => {
  const inRouter = useInRouterContext();
  const queryClient = useQueryClient();
  const { isEnabled } = useFeatureFlags();
  const { data, loading, error, refetch } = useReadinessDomain('roadmap');

  const [isEditing, setIsEditing] = useState(false);
  const [paceMode, setPaceMode] = useState<'standard' | 'crash'>('standard');
  const [crashWindow, setCrashWindow] = useState<CrashCourseWindow>('7d');
  const [togglingSkills, setTogglingSkills] = useState<Record<string, boolean>>({});
  const [selectedSkill, setSelectedSkill] = useState<string>('');
  const [skillFilter, setSkillFilter] = useState<SkillFilterTab>('all');
  const [skillSearch, setSkillSearch] = useState('');
  const [resourceCache, setResourceCache] = useState<Record<string, LearningResource>>({});
  const [loadingResource, setLoadingResource] = useState(false);
  const [doneResources, setDoneResources] = useState<Record<string, boolean>>(() => loadDoneResources());
  const [deadlineWeeks, setDeadlineWeeks] = useState<number>(12);
  const [generatingMilestones, setGeneratingMilestones] = useState(false);
  const [milestoneError, setMilestoneError] = useState<string | null>(null);
  const [hasTrackedRoadmap, setHasTrackedRoadmap] = useState(false);

  const roadmap = data as ReadinessRoadmapDomainResponse | undefined;
  const noRoleSelected = (data as any)?.noRoleSelected || !roadmap || roadmap.currentStage === 'Unknown';

  const {
    data: milestoneRoadmap,
    isLoading: milestonesLoading,
  } = useQuery<MilestoneRoadmapApiResponse | null>({
    queryKey: ['milestoneRoadmap'],
    queryFn: ({ signal }) => readinessService.getMilestoneRoadmap({ signal }),
    enabled: !loading && !noRoleSelected,
    staleTime: 60_000,
    retry: false,
  });

  const {
    data: crashCoursePlan,
    isLoading: crashCourseLoading,
    error: crashCourseQueryError,
    refetch: refetchCrashCourse,
  } = useQuery<CrashCoursePlan>({
    queryKey: ['crashCoursePlan', crashWindow],
    queryFn: ({ signal }) => readinessService.getCrashCoursePlan(crashWindow, { signal }),
    enabled: !loading && !noRoleSelected && paceMode === 'crash',
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (roadmap?.targetDeadlineWeeks && roadmap.targetDeadlineWeeks >= 2) {
      setDeadlineWeeks(roadmap.targetDeadlineWeeks);
    }
  }, [roadmap?.targetDeadlineWeeks]);

  useEffect(() => {
    if (roadmap && !noRoleSelected && !hasTrackedRoadmap && !loading && !error) {
      analyticsService.trackEvent('roadmap_generated', {
        targetRole: roadmap.targetRole || roadmap.domain,
        roadmapProgress: roadmap.roadmapProgress,
        nextSkill: roadmap.nextSkill,
      });
      setHasTrackedRoadmap(true);
    }
  }, [roadmap, noRoleSelected, hasTrackedRoadmap, loading, error]);

  // Seed active skill and pre-fetched resources
  useEffect(() => {
    if (!roadmap || noRoleSelected) return;
    if (roadmap.skillResources) {
      setResourceCache((prev) => ({ ...roadmap.skillResources, ...prev }));
    } else if (roadmap.nextSkillResource && roadmap.nextSkill) {
      setResourceCache((prev) => ({ [roadmap.nextSkill]: roadmap.nextSkillResource!, ...prev }));
    }
    if (!selectedSkill && roadmap.nextSkill) {
      setSelectedSkill(roadmap.nextSkill);
    }
  }, [roadmap, noRoleSelected, selectedSkill]);

  const activeSkill = selectedSkill || roadmap?.nextSkill || '';

  const handleSelectSkill = async (skill: string) => {
    if (!skill) return;
    setSelectedSkill(skill);
    if (resourceCache[skill] || roadmap?.skillResources?.[skill]) {
      return;
    }
    setLoadingResource(true);
    try {
      const resource = await readinessService.getSkillResource(skill);
      setResourceCache((prev) => ({ ...prev, [skill]: resource }));
    } catch {
      // Non-fatal: UI falls back gracefully
    } finally {
      setLoadingResource(false);
    }
  };

  const activeResource: LearningResource | null =
    (activeSkill && (resourceCache[activeSkill] || roadmap?.skillResources?.[activeSkill])) ||
    (activeSkill && activeSkill === roadmap?.nextSkill ? roadmap?.nextSkillResource ?? null : null) ||
    null;

  const handleSkillToggle = async (skill: string, completed: boolean) => {
    if (togglingSkills[skill]) return;
    setTogglingSkills((prev) => ({ ...prev, [skill]: true }));
    try {
      await readinessService.toggleSkillProgress(skill, completed);
      if (completed) {
        analyticsService.trackEvent('skill_marked_complete', {
          skill,
          newProgress: roadmap?.roadmapProgress,
        });
      }
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: ['milestoneRoadmap'] }),
        queryClient.invalidateQueries({ queryKey: ['crashCoursePlan'] }),
      ]);
    } finally {
      setTogglingSkills((prev) => ({ ...prev, [skill]: false }));
    }
  };

  const handleGenerateMilestones = async () => {
    const roleId = milestoneRoadmap?.targetRoleId || roleToSlug(roadmap?.targetRole || 'Backend Developer');
    setGeneratingMilestones(true);
    setMilestoneError(null);
    try {
      const generated = await readinessService.generateMilestoneRoadmap({
        targetRoleId: roleId,
        targetDeadlineWeeks: deadlineWeeks,
      });
      queryClient.setQueryData(['milestoneRoadmap'], generated);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Could not generate 2-week sprint roadmap.';
      setMilestoneError(msg);
    } finally {
      setGeneratingMilestones(false);
    }
  };

  const handleToggleMilestoneTask = async (change: RoadmapTaskToggle) => {
    const updated = await readinessService.toggleMilestoneTask(
      change.milestoneId,
      change.taskId,
      change.completed
    );
    queryClient.setQueryData(['milestoneRoadmap'], updated);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['readinessDomain', 'roadmap'] }),
      queryClient.invalidateQueries({ queryKey: ['readinessData'] }),
      queryClient.invalidateQueries({ queryKey: ['placementRadar'] }),
    ]);
  };

  const toggleResourceDone = (url: string) => {
    setDoneResources((prev) => {
      const next = { ...prev, [url]: !prev[url] };
      saveDoneResources(next);
      return next;
    });
  };

  const timelineMilestones = useMemo(
    () => mapMilestoneRoadmapToTimeline(milestoneRoadmap ?? null),
    [milestoneRoadmap]
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-6 max-w-[1400px] mx-auto w-full pb-16 px-4 pt-6 animate-pulse">
        <div className="h-20 w-80 bg-slate-200/60 rounded-2xl" />
        <div className="h-40 bg-slate-200/60 rounded-2xl" />
        <div className="h-64 bg-slate-200/60 rounded-2xl" />
      </div>
    );
  }

  if (error || !roadmap) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh]">
        <EmptyState
          size="lg"
          icon="alert"
          title="Unable to load roadmap intelligence."
          description="Please try again."
          action={
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-2 px-6 py-2.5 rounded-xl bg-indigo-600 text-white font-semibold shadow-xs hover:bg-indigo-700 transition-colors"
            >
              Retry
            </button>
          }
        />
      </div>
    );
  }

  if (noRoleSelected || isEditing) {
    return (
      <div className="min-h-screen bg-slate-50/50 relative overflow-x-hidden">
        <div className="absolute top-0 inset-x-0 h-[500px] bg-gradient-to-b from-indigo-50/80 via-white to-transparent -z-10 pointer-events-none" />
        <div className="max-w-[1400px] mx-auto w-full pb-24 px-4 md:px-8 min-w-0">
          <div className="pt-6 pb-2">
            <WorkspaceHeader
              domain="Roadmap"
              title="Roadmap Intelligence"
              coreQuestion="What should I learn next, and why?"
              icon={<MapIcon size={24} />}
              accentColor="#4f46e5"
            />
          </div>
          <CareerDiscoveryForm
            initialValues={
              !noRoleSelected
                ? {
                    targetRole: roadmap.targetRole || undefined,
                    goal: roadmap.goal || undefined,
                    experienceLevel: roadmap.experienceLevel || undefined,
                    weeklyHours: roadmap.weeklyHours || 10,
                    targetDeadlineWeeks: roadmap.targetDeadlineWeeks || 12,
                    knownSkills: [...(roadmap.verifiedSkills ?? []), ...(roadmap.completedRoadmapSkills ?? [])],
                  }
                : undefined
            }
            onComplete={(result) => {
              setIsEditing(false);
              setSelectedSkill('');
              if (result?.paceMode === 'crash') {
                setPaceMode('crash');
                if (result.crashWindow) {
                  setCrashWindow(result.crashWindow);
                }
              } else {
                setPaceMode('standard');
              }
              void refetch();
              void queryClient.invalidateQueries({ queryKey: ['milestoneRoadmap'] });
              void queryClient.invalidateQueries({ queryKey: ['crashCoursePlan'] });
            }}
            onCancel={noRoleSelected ? undefined : () => setIsEditing(false)}
          />
        </div>
      </div>
    );
  }

  const verifiedSkillSources = roadmap.verifiedSkillSources ?? [];
  const sourceBySkill = new Map<string, VerifiedSkillSource['source']>(
    verifiedSkillSources.map((entry) => [entry.skill.toLowerCase(), entry.source])
  );
  const prioritySet = new Set(roadmap.prioritySkills ?? []);
  const verifiedSkillsList = roadmap.verifiedSkills ?? [];
  const completedSelfList = roadmap.completedRoadmapSkills ?? [];
  const missingList = roadmap.missingSkills ?? [];

  type BoardSkillItem = {
    skill: string;
    status: 'verified' | 'self' | 'priority' | 'missing';
    sourceLabel?: string;
  };

  const allBoardSkills: BoardSkillItem[] = [
    ...roadmap.prioritySkills.map((skill) => ({ skill, status: 'priority' as const })),
    ...missingList
      .filter((skill) => !prioritySet.has(skill))
      .map((skill) => ({ skill, status: 'missing' as const })),
    ...verifiedSkillsList.map((skill) => ({
      skill,
      status: 'verified' as const,
      sourceLabel: SOURCE_LABELS[sourceBySkill.get(skill.toLowerCase()) ?? 'resume'],
    })),
    ...completedSelfList.map((skill) => ({
      skill,
      status: 'self' as const,
      sourceLabel: 'Self-marked',
    })),
  ];

  const completedCount = verifiedSkillsList.length + completedSelfList.length;
  const completedLowerSet = new Set(
    [...verifiedSkillsList, ...completedSelfList].map((skill) => skill.toLowerCase())
  );
  const skillsOutOfSync = Boolean(
    milestoneRoadmap?.milestones?.some(
      (milestone) =>
        !milestone.completed &&
        milestone.skills.some((skill) => completedLowerSet.has(skill.toLowerCase()))
    )
  );
  const filteredBoardSkills = allBoardSkills.filter((item) => {
    if (skillFilter === 'priority' && item.status !== 'priority') return false;
    if (skillFilter === 'remaining' && item.status !== 'priority' && item.status !== 'missing') return false;
    if (skillFilter === 'completed' && item.status !== 'verified' && item.status !== 'self') return false;
    if (skillSearch.trim()) {
      return item.skill.toLowerCase().includes(skillSearch.trim().toLowerCase());
    }
    return true;
  });

  const focusPath = `/focus?mission=${encodeURIComponent(`Master ${activeSkill}`)}&duration=25&mode=core`;
  const projectDraftUrl = activeResource
    ? `/projects?create=1&title=${encodeURIComponent(activeResource.practiceProject.title)}&description=${encodeURIComponent(activeResource.practiceProject.description)}&tech=${encodeURIComponent(activeSkill)}`
    : '/projects?create=1';

  const renderNavAction = (
    to: string,
    className: string,
    children: React.ReactNode
  ) =>
    inRouter ? (
      <Link to={to} className={className}>
        {children}
      </Link>
    ) : (
      <a href={to} className={className}>
        {children}
      </a>
    );

  return (
    <div className="min-h-screen bg-slate-50/50 relative overflow-x-hidden">
      <div className="absolute top-0 inset-x-0 h-[500px] bg-gradient-to-b from-indigo-50/80 via-white to-transparent -z-10 pointer-events-none" />

      <div className="max-w-[1400px] mx-auto w-full pb-24 px-4 md:px-8 min-w-0">
        <div className="pt-6 pb-2 flex flex-col md:flex-row md:items-center justify-between gap-4 min-w-0">
          <WorkspaceHeader
            domain="Roadmap"
            title="Roadmap Intelligence"
            coreQuestion="What should I learn next, and why?"
            icon={<MapIcon size={24} />}
            accentColor="#4f46e5"
          />
          <div className="mb-4 md:mb-8 flex flex-wrap items-center gap-2.5 shrink-0">
            <div className="inline-flex rounded-xl border border-slate-200/80 bg-white p-1 shadow-xs">
              <button
                type="button"
                onClick={() => setPaceMode('standard')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  paceMode === 'standard'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Full Roadmap
              </button>
              <button
                type="button"
                onClick={() => setPaceMode('crash')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  paceMode === 'crash'
                    ? 'bg-amber-500 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Zap size={13} />
                Crash Course Blitz
              </button>
            </div>
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="px-4 py-2.5 bg-white border border-slate-200/80 hover:border-indigo-300 hover:text-indigo-600 text-slate-600 font-semibold rounded-xl text-xs inline-flex items-center gap-1.5 shadow-xs transition-colors w-fit whitespace-nowrap cursor-pointer"
            >
              <RefreshCcw size={14} /> Reset & Learn Something Else
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-6 mt-4 min-w-0">
          {paceMode === 'crash' ? (
            <CrashCourseWorkspace
              window={crashWindow}
              onWindowChange={setCrashWindow}
              plan={crashCoursePlan}
              isLoading={crashCourseLoading}
              error={
                crashCourseQueryError
                  ? crashCourseQueryError instanceof Error
                    ? crashCourseQueryError.message
                    : 'Unable to load crash course plan.'
                  : null
              }
              onRetry={() => void refetchCrashCourse()}
              onMarkTopicRevised={(skill, revised) => handleSkillToggle(skill, revised)}
            />
          ) : (
            <>
          {/* ─── Progress Overview (Hero) ─── */}
          <div className="relative overflow-hidden rounded-2xl bg-white border border-slate-200/80 p-6 md:p-8 shadow-xs">
            <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-50 rounded-full blur-[80px] -mr-20 -mt-20 opacity-80 pointer-events-none" />

            <div className="relative z-10 flex flex-col md:flex-row items-center gap-8 min-w-0">
              <div className="shrink-0">
                <ProgressRing percent={roadmap.roadmapProgress} />
              </div>
              <div className="flex-1 text-center md:text-left min-w-0">
                <div className="flex flex-wrap items-center justify-center md:justify-start gap-2.5 mb-2">
                  <h3 className="text-2xl font-bold text-slate-900 tracking-tight">Total Progress</h3>
                  {roadmap.targetRole && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                      <Target size={12} />
                      Target: {roadmap.targetRole} · {roadmap.weeklyHours || 10} hrs/wk
                    </span>
                  )}
                </div>
                <p className="text-slate-500 text-sm mb-6">
                  Verified across your resume, GitHub repositories, projects, and roadmap milestones
                </p>

                <div className="flex flex-wrap justify-center md:justify-start gap-8">
                  <div className="flex flex-col items-center md:items-start">
                    <div className="text-3xl font-black text-slate-900 tracking-tighter tabular-nums">
                      {completedCount}
                    </div>
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Completed</div>
                  </div>
                  <div className="w-px h-12 bg-slate-200 hidden md:block" />
                  <div className="flex flex-col items-center md:items-start">
                    <div className="text-3xl font-black text-slate-900 tracking-tighter tabular-nums">
                      {missingList.length}
                    </div>
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Missing</div>
                  </div>
                  <div className="w-px h-12 bg-slate-200 hidden md:block" />
                  <div className="flex flex-col items-center md:items-start">
                    <div className="text-3xl font-black text-slate-900 tracking-tighter tabular-nums">
                      {roadmap.prioritySkills.length}
                    </div>
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Priority</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ─── Stage / Next / Readiness Gain / Next Milestone ─── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            <div className="rounded-2xl bg-white border border-slate-200/80 p-5 shadow-xs min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <div className="p-2 bg-indigo-50 rounded-lg text-indigo-600">
                  <Target size={16} />
                </div>
                <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Current Stage</h3>
              </div>
              <div className="text-xl font-bold text-slate-900 tracking-tight mb-3">{roadmap.currentStage}</div>
              <div className="flex gap-1">
                {['Foundation', 'Intermediate', 'Advanced'].map((s) => (
                  <div
                    key={s}
                    className={`h-1.5 flex-1 rounded-full ${s === roadmap.currentStage ? 'bg-indigo-500' : 'bg-slate-200'}`}
                    title={s}
                  />
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-slate-200/80 p-5 shadow-xs min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <div className="p-2 bg-emerald-50 rounded-lg text-emerald-600">
                  <ArrowRight size={16} />
                </div>
                <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Focus Skill</h3>
              </div>
              <div className="text-xl font-bold text-slate-900 tracking-tight mb-2 truncate">
                {activeSkill || 'All Covered'}
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700">
                <Star size={11} /> Active Focus
              </span>
            </div>

            <div className="rounded-2xl bg-white border border-slate-200/80 p-5 shadow-xs min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <div className="p-2 bg-amber-50 rounded-lg text-amber-600">
                  <Zap size={16} />
                </div>
                <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Readiness Gain</h3>
              </div>
              <div className="text-3xl font-black text-slate-900 tracking-tighter tabular-nums">
                <span className="text-amber-500">+</span>{roadmap.readinessGain}
                <span className="text-lg font-bold text-slate-400 ml-1">%</span>
              </div>
              <p className="text-xs text-slate-500 mt-2">Estimated boost per verified skill</p>
            </div>

            <div className="rounded-2xl bg-white border border-slate-200/80 p-5 shadow-xs min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <div className="p-2 bg-slate-100 rounded-lg text-slate-600">
                  <Clock size={16} />
                </div>
                <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Estimated Horizon</h3>
              </div>
              <div className="text-3xl font-black text-slate-900 tracking-tighter tabular-nums">
                {milestoneRoadmap?.targetDeadlineWeeks || roadmap.estimatedWeeksToNextMilestone}
                <span className="text-lg font-bold text-slate-400 ml-1.5">wks</span>
              </div>
              <p className="text-xs text-slate-500 mt-2">At {roadmap.weeklyHours || 10} hrs/wk pace</p>
            </div>
          </div>

          {/* ─── Unified Skill Mastery Board ─── */}
          <section className="rounded-2xl bg-white border border-slate-200/80 p-6 shadow-xs min-w-0">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600">
                  <Layers size={16} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Skill Mastery Board</h3>
                  <p className="text-xs text-slate-500">
                    Click any skill to inspect its learning path, or check off skills you have mastered
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    placeholder="Filter skills..."
                    aria-label="Filter skills"
                    className="rounded-xl border border-slate-200 bg-slate-50/70 pl-8 pr-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-44"
                  />
                </div>

                <div className="inline-flex flex-wrap rounded-xl border border-slate-200 bg-slate-50 p-1 gap-1">
                  {(
                    [
                      { id: 'all', label: `All (${allBoardSkills.length})` },
                      { id: 'priority', label: `Priority (${roadmap.prioritySkills.length})` },
                      { id: 'remaining', label: `Remaining (${missingList.length})` },
                      { id: 'completed', label: `Verified & Completed (${completedCount})` },
                    ] as Array<{ id: SkillFilterTab; label: string }>
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setSkillFilter(tab.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                        skillFilter === tab.id
                          ? 'bg-white text-indigo-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filteredBoardSkills.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-500">
                No skills match the current filter.
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2.5">
                {filteredBoardSkills.map((item) => {
                  const isSelected = activeSkill.toLowerCase() === item.skill.toLowerCase();
                  if (item.status === 'verified') {
                    return (
                      <div
                        key={item.skill}
                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                          isSelected
                            ? 'border-emerald-400 bg-emerald-100/80 text-emerald-900 ring-2 ring-emerald-200'
                            : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        }`}
                      >
                        <CheckCircle size={13} className="text-emerald-600 shrink-0" />
                        <button
                          type="button"
                          onClick={() => void handleSelectSkill(item.skill)}
                          className="cursor-pointer hover:underline"
                        >
                          {item.skill}
                        </button>
                        <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 border border-emerald-200/80">
                          {item.sourceLabel}
                        </span>
                      </div>
                    );
                  }

                  if (item.status === 'self') {
                    return (
                      <div
                        key={item.skill}
                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                          togglingSkills[item.skill] ? 'opacity-50' : ''
                        } ${
                          isSelected
                            ? 'border-emerald-400 bg-emerald-100/80 text-emerald-900 ring-2 ring-emerald-200'
                            : 'border-emerald-200 bg-emerald-50/70 text-emerald-800'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={true}
                          disabled={togglingSkills[item.skill]}
                          onChange={() => void handleSkillToggle(item.skill, false)}
                          aria-label={`Mark ${item.skill} incomplete`}
                          className="accent-emerald-600 cursor-pointer w-3.5 h-3.5"
                        />
                        <button
                          type="button"
                          onClick={() => void handleSelectSkill(item.skill)}
                          className="cursor-pointer hover:underline"
                        >
                          {item.skill}
                        </button>
                        <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 border border-emerald-200/80">
                          Self-marked
                        </span>
                      </div>
                    );
                  }

                  const isPriority = item.status === 'priority';
                  return (
                    <div
                      key={item.skill}
                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        togglingSkills[item.skill] ? 'opacity-50' : ''
                      } ${
                        isSelected
                          ? 'border-indigo-400 bg-indigo-100/70 text-indigo-900 ring-2 ring-indigo-200'
                          : isPriority
                            ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100/60'
                            : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100/60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={false}
                        disabled={togglingSkills[item.skill]}
                        onChange={() => void handleSkillToggle(item.skill, true)}
                        aria-label={`Mark ${item.skill} complete`}
                        className={`${isPriority ? 'accent-indigo-600' : 'accent-amber-600'} cursor-pointer w-3.5 h-3.5`}
                      />
                      <button
                        type="button"
                        onClick={() => void handleSelectSkill(item.skill)}
                        className="cursor-pointer hover:underline"
                      >
                        {item.skill}
                      </button>
                      {isPriority && (
                        <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 border border-indigo-200">
                          Priority
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ─── 2-Week Sprint Roadmap (Milestone Timeline) ─── */}
          <section className="rounded-2xl bg-white border border-slate-200/80 p-6 shadow-xs min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 mb-5 border-b border-slate-100">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-2 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-600 shrink-0">
                  <Sparkles size={16} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-bold text-slate-900">2-Week Sprint Roadmap</h3>
                  <p className="text-xs text-slate-500">
                    Sequential week-by-week milestones with persistent task tracking
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <label className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-1.5 text-xs font-semibold text-slate-600">
                  <span>Deadline</span>
                  <select
                    value={deadlineWeeks}
                    onChange={(e) => setDeadlineWeeks(Number(e.target.value))}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
                  >
                    {[4, 8, 12, 16, 20].map((wks) => (
                      <option key={wks} value={wks}>{wks} wks</option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  onClick={() => void handleGenerateMilestones()}
                  disabled={generatingMilestones}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors whitespace-nowrap cursor-pointer"
                >
                  <RefreshCcw size={13} className={generatingMilestones ? 'animate-spin' : ''} />
                  {generatingMilestones
                    ? 'Generating...'
                    : milestoneRoadmap
                      ? 'Regenerate Sprint Plan'
                      : 'Generate Sprint Plan'}
                </button>
              </div>
            </div>

            {skillsOutOfSync && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
                <span className="font-semibold">
                  Skills updated — Regenerate Sprint Plan to align active milestones with your completed skills.
                </span>
                <button
                  type="button"
                  onClick={() => void handleGenerateMilestones()}
                  disabled={generatingMilestones}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-700 disabled:opacity-60 cursor-pointer"
                >
                  {generatingMilestones ? 'Regenerating...' : 'Regenerate Sprint Plan'}
                </button>
              </div>
            )}

            {milestoneError && (
              <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-medium text-rose-700">
                {milestoneError}
              </div>
            )}

            {milestonesLoading ? (
              <div className="space-y-3 animate-pulse">
                <div className="h-20 rounded-xl bg-slate-100" />
                <div className="h-20 rounded-xl bg-slate-100" />
              </div>
            ) : milestoneRoadmap && timelineMilestones.length > 0 ? (
              <RoadmapMilestoneTimeline
                roadmapId={milestoneRoadmap.id}
                milestones={timelineMilestones}
                onToggleTask={handleToggleMilestoneTask}
              />
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center">
                <p className="text-sm font-semibold text-slate-700">
                  No 2-week sprint milestones generated yet.
                </p>
                <p className="text-xs text-slate-500 mt-1 mb-4">
                  Turn your missing skills into concrete 2-week architecture, DSA, and verification sprints.
                </p>
                <button
                  type="button"
                  onClick={() => void handleGenerateMilestones()}
                  disabled={generatingMilestones}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors cursor-pointer"
                >
                  <Sparkles size={13} />
                  {generatingMilestones ? 'Generating...' : 'Generate 2-Week Sprint Plan'}
                </button>
              </div>
            )}
          </section>

          {/* ─── Bottom Section (Interactive Learning Path + Highest Impact Skill) ─── */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-w-0">
            <div className="lg:col-span-8 rounded-2xl bg-white border border-slate-200/80 p-6 shadow-xs min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-5">
                <div>
                  <h3 className="text-base font-bold text-slate-900">Learning Path</h3>
                  <p className="text-xs text-slate-500">Select a step to load its practice project and curated resources</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {roadmap.nextThreeSkills.length ? (
                  roadmap.nextThreeSkills.slice(0, 3).map((s, idx) => {
                    const isActive = activeSkill.toLowerCase() === s.toLowerCase();
                    const stepStatus = idx === 0 ? 'Active Step' : idx === 1 ? 'Up Next' : 'Queued';
                    const skillGain = roadmap.skillGains?.[s] ?? Math.max(4, roadmap.readinessGain - idx * 3);
                    return (
                      <button
                        key={`${s}_${idx}`}
                        type="button"
                        onClick={() => void handleSelectSkill(s)}
                        className={`text-left rounded-2xl p-4 border transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                          isActive
                            ? 'border-indigo-400 bg-indigo-50/60 ring-2 ring-indigo-100 shadow-xs'
                            : 'border-slate-200/80 bg-white hover:border-indigo-200 hover:bg-slate-50/50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 w-full">
                          <span
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                              isActive
                                ? 'bg-indigo-600 text-white'
                                : 'bg-indigo-50 border border-indigo-100 text-indigo-600'
                            }`}
                          >
                            {idx + 1}
                          </span>
                          <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md border border-slate-200 bg-white text-slate-600">
                            {stepStatus}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-bold text-slate-900 truncate">{s}</div>
                          <div className="text-[11px] font-semibold text-emerald-700 mt-1 tabular-nums">
                            +{skillGain}% readiness gain
                          </div>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="col-span-full text-sm text-slate-500 py-4 text-center">
                    All required skills for this track are complete!
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-4 rounded-2xl bg-gradient-to-br from-indigo-600 to-indigo-800 text-white p-6 shadow-md relative overflow-hidden min-w-0 flex flex-col justify-between">
              <div className="absolute top-0 right-0 w-48 h-48 bg-white rounded-full blur-[70px] -mr-20 -mt-20 opacity-10 pointer-events-none" />
              <div className="relative z-10">
                <div className="flex items-center gap-2 mb-3 text-indigo-100">
                  <Star size={15} fill="currentColor" />
                  <h3 className="text-[11px] font-bold uppercase tracking-widest">Highest Impact Skill</h3>
                </div>
                <div className="text-2xl font-black tracking-tight leading-tight mb-2">
                  {roadmap.highestImpactSkill || 'Track Complete'}
                </div>
                <p className="text-xs text-indigo-100/90 leading-relaxed">
                  Mastering this skill currently unlocks the largest readiness gain for your target role.
                </p>
              </div>
              {roadmap.highestImpactSkill && (
                <button
                  type="button"
                  onClick={() => void handleSelectSkill(roadmap.highestImpactSkill)}
                  className="relative z-10 mt-4 inline-flex items-center gap-1.5 rounded-xl bg-white/15 hover:bg-white/25 px-3.5 py-2 text-xs font-semibold text-white transition-colors w-fit cursor-pointer"
                >
                  Open Skill Guide <ArrowRight size={13} />
                </button>
              )}
            </div>
          </div>

          {/* ─── Learning Resource & Execution Bridges ─── */}
          {(activeResource || loadingResource) && (
            <section
              className={`rounded-2xl border p-6 shadow-xs min-w-0 ${
                activeResource?.isFallback ? 'bg-slate-50/70 border-slate-200' : 'bg-white border-slate-200/80'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3 mb-5 pb-4 border-b border-slate-100">
                <div className="flex items-center gap-3 min-w-0">
                  <BookOpen className="text-indigo-600 shrink-0" size={20} />
                  <h3 className="text-lg font-bold tracking-tight text-slate-900 flex items-center flex-wrap gap-2.5">
                    Learning Resource: {activeResource?.skill || activeSkill}
                    {activeResource?.isFallback && (
                      <span className="px-2.5 py-0.5 bg-amber-100 text-amber-800 text-[10px] uppercase tracking-wider font-bold rounded-full border border-amber-200 inline-flex items-center gap-1">
                        <AlertTriangle size={11} /> Community Resource Fallback
                      </span>
                    )}
                  </h3>
                </div>
                {activeResource?.estimatedTime && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-100 text-slate-700 rounded-full text-xs font-semibold border border-slate-200 shrink-0">
                    <Clock size={13} />
                    {activeResource.estimatedTime}
                  </span>
                )}
              </div>

              {loadingResource && !activeResource ? (
                <div className="h-32 rounded-xl bg-slate-100 animate-pulse" />
              ) : activeResource ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 min-w-0">
                  <div className="space-y-5 min-w-0">
                    <div>
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Why Learn This?</h4>
                      <p className="text-sm text-slate-700 leading-relaxed">{activeResource.whyLearn}</p>
                    </div>

                    <div className="bg-indigo-50/70 border border-indigo-100 rounded-2xl p-5 space-y-3">
                      <div className="flex items-center gap-2">
                        <Target className="text-indigo-600" size={17} />
                        <h4 className="text-sm font-bold text-indigo-950">Practice Project</h4>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-indigo-900">{activeResource.practiceProject.title}</p>
                        <p className="text-xs text-indigo-800/80 mt-1 leading-relaxed">
                          {activeResource.practiceProject.description}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 pt-2">
                        {renderNavAction(
                          focusPath,
                          'inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors whitespace-nowrap',
                          <>
                            <Clock size={13} aria-hidden="true" />
                            Start 25m Focus Block
                          </>
                        )}
                        {renderNavAction(
                          projectDraftUrl,
                          'inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-white px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 transition-colors whitespace-nowrap',
                          <>
                            <FolderPlus size={13} aria-hidden="true" />
                            Create in Projects
                          </>
                        )}
                        {isEnabled(INTERVIEW_STUDIO_FLAG) &&
                          renderNavAction(
                            INTERVIEW_STUDIO_PATH,
                            'inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap',
                            <>
                              <MessageSquare size={13} aria-hidden="true" />
                              Practice Interview
                            </>
                          )}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3 min-w-0">
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Curated Resources</h4>
                    <div className="space-y-2.5">
                      {activeResource.resources.map((res, i) => {
                        const isDone = Boolean(doneResources[res.url]);
                        return (
                          <div
                            key={`${res.url}_${i}`}
                            className={`flex items-center justify-between gap-3 p-3 rounded-xl border transition-colors ${
                              isDone
                                ? 'border-emerald-200 bg-emerald-50/40'
                                : 'border-slate-200 bg-white hover:border-indigo-300'
                            }`}
                          >
                            <div className="flex items-center gap-3 min-w-0 flex-1">
                              <label className="inline-flex items-center gap-1.5 shrink-0 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={isDone}
                                  onChange={() => toggleResourceDone(res.url)}
                                  aria-label={`Mark ${res.title} done`}
                                  className="accent-emerald-600 w-4 h-4 cursor-pointer"
                                />
                                <span className="text-[11px] font-semibold text-slate-500">Done</span>
                              </label>

                              <div className="text-slate-400 shrink-0">
                                {res.type === 'video' || res.type === 'course' ? (
                                  <PlayCircle size={17} />
                                ) : (
                                  <BookOpen size={17} />
                                )}
                              </div>

                              <a
                                href={res.url}
                                target="_blank"
                                rel="noreferrer"
                                onClick={() => {
                                  analyticsService.trackEvent('resource_clicked', {
                                    skill: activeResource.skill,
                                    resourceType: res.type,
                                    provider: res.provider,
                                  });
                                }}
                                className="min-w-0 flex-1 group"
                              >
                                <p className={`text-sm font-semibold truncate group-hover:text-indigo-700 ${isDone ? 'line-through text-slate-500' : 'text-slate-800'}`}>
                                  {res.title}
                                </p>
                                <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                                    {RESOURCE_TYPE_LABELS[res.type] ?? res.type}
                                  </span>
                                  <span className="text-[11px] text-slate-500">{res.provider}</span>
                                </div>
                              </a>
                            </div>

                            <a
                              href={res.url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Open ${res.title}`}
                              className="text-slate-400 hover:text-indigo-600 shrink-0 p-1"
                            >
                              <ArrowRight size={15} />
                            </a>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
            </section>
          )}
            </>
          )}

          <FeedbackWidget />
        </div>
      </div>
    </div>
  );
};

export default RoadmapIntelligencePage;
