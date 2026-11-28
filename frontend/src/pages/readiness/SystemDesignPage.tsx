import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Zap } from 'lucide-react';
import { WorkspaceHeader } from '../../features/readiness/components/WorkspaceHeader';
import { ConceptWorkspaceShell } from '../../features/readiness/components/ConceptWorkspaceShell';
import { NetworkErrorPanel } from '../../components/shared/NetworkErrorPanel';
import {
  readinessService,
  type ConceptConfidence,
  type ConceptLevel,
  type ConceptWorkspaceResponse,
} from '../../services/readinessService';

type LevelFilter = 'all' | ConceptLevel;

const LEVEL_TABS: Array<{ id: LevelFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'case-study', label: 'Case Studies' },
];

const SystemDesignPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [crashCourseOnly, setCrashCourseOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const { data, isLoading, error, refetch } = useQuery<ConceptWorkspaceResponse>({
    queryKey: ['conceptWorkspace', 'system-design'],
    queryFn: ({ signal }) => readinessService.getConceptWorkspace('system-design', { signal }),
    staleTime: 60_000,
  });

  const updateMutation = useMutation({
    mutationFn: ({
      conceptId,
      patch,
    }: {
      conceptId: string;
      patch: { completed?: boolean; confidence?: ConceptConfidence | null };
    }) => readinessService.updateConceptProgress('system-design', conceptId, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['conceptWorkspace', 'system-design'], updated);
      void queryClient.invalidateQueries({ queryKey: ['placementRadar'] });
    },
  });

  const filteredConcepts = useMemo(() => {
    const concepts = data?.concepts ?? [];
    return concepts.filter((item) => {
      if (levelFilter !== 'all' && item.level !== levelFilter) return false;
      if (crashCourseOnly && !item.isHighFrequencyCrashCourse) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        return (
          item.title.toLowerCase().includes(q) ||
          item.subtitle.toLowerCase().includes(q) ||
          item.summary.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [data?.concepts, levelFilter, crashCourseOnly, searchQuery]);

  if (isLoading) {
    return (
      <div className="max-w-[1400px] mx-auto w-full pb-16 px-4 md:px-6 space-y-6 animate-pulse">
        <div className="h-24 bg-slate-100 rounded-2xl" />
        <div className="h-96 bg-slate-100 rounded-2xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-[1400px] mx-auto w-full px-4 md:px-6 py-10">
        <NetworkErrorPanel
          error={error instanceof Error ? error.message : 'Unable to load System Design workspace'}
          onRetry={() => void refetch()}
          variant="centered"
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50/40 overflow-x-hidden">
      <div className="max-w-[1400px] mx-auto w-full pb-20 px-4 md:px-8 space-y-6">
        <div className="pt-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <WorkspaceHeader
            domain="System Design"
            title="System Design Concepts"
            coreQuestion="How do I design scalable, fault-tolerant architectures from first principles?"
            icon={<Layers size={22} />}
            accentColor="#4F46E5"
          />

          <div className="inline-flex items-center gap-3 rounded-2xl border border-indigo-200 bg-white px-4 py-2.5 shadow-xs self-start md:self-auto shrink-0">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Architecture Mastery
              </div>
              <div className="text-sm font-black text-slate-900 tabular-nums">
                {data.summary.completedConcepts} / {data.summary.totalConcepts} concepts mastered ({data.summary.progressPercent}%)
              </div>
            </div>
          </div>
        </div>

        <ConceptWorkspaceShell
          concepts={data.concepts}
          filteredConcepts={filteredConcepts}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchPlaceholder="Search protocols, caching, sharding, or case studies..."
          flowHeading="Architecture Flow Mental Model"
          matrixHeading="Trade-Off Matrix"
          benchmarkHeading="Scale Benchmarks"
          focusMinutes={25}
          focusButtonLabel="Start 25m Focus"
          interviewButtonLabel="Mock Interview"
          isUpdating={updateMutation.isPending}
          onUpdateConcept={(conceptId, patch) =>
            updateMutation.mutate({ conceptId, patch })
          }
          filterControls={
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Difficulty levels">
                {LEVEL_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={levelFilter === tab.id}
                    onClick={() => setLevelFilter(tab.id)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      levelFilter === tab.id
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'bg-slate-100/80 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                aria-pressed={crashCourseOnly}
                onClick={() => setCrashCourseOnly((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  crashCourseOnly
                    ? 'border-amber-300 bg-amber-500 text-white shadow-xs'
                    : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                }`}
              >
                <Zap size={13} />
                Crash Course Filter
              </button>
            </div>
          }
        />
      </div>
    </div>
  );
};

export default SystemDesignPage;
