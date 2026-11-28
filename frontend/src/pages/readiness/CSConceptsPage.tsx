import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Info, Zap } from 'lucide-react';
import { WorkspaceHeader } from '../../features/readiness/components/WorkspaceHeader';
import { ConceptWorkspaceShell } from '../../features/readiness/components/ConceptWorkspaceShell';
import { NetworkErrorPanel } from '../../components/shared/NetworkErrorPanel';
import {
  readinessService,
  type ConceptConfidence,
  type ConceptWorkspaceResponse,
  type CsSubTrack,
} from '../../services/readinessService';

type SubTrackFilter = 'core-all' | CsSubTrack;
type TierFilter = 'all' | 'beginner' | 'intermediate' | 'advanced';

const DS_OPT_IN_STORAGE_KEY = 'devtrack:cs-concepts:include-distributed-systems';

function readInitialOptIn(): boolean {
  try {
    return window.localStorage.getItem(DS_OPT_IN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

const CSConceptsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [includeDistributed, setIncludeDistributed] = useState<boolean>(readInitialOptIn);
  const [subTrackFilter, setSubTrackFilter] = useState<SubTrackFilter>('core-all');
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [rapidOnly, setRapidOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const { data, isLoading, error, refetch } = useQuery<ConceptWorkspaceResponse>({
    queryKey: ['conceptWorkspace', 'cs-concepts'],
    queryFn: ({ signal }) => readinessService.getConceptWorkspace('cs-concepts', { signal }),
    staleTime: 60_000,
  });

  const updateMutation = useMutation({
    mutationFn: ({
      conceptId,
      patch,
    }: {
      conceptId: string;
      patch: { completed?: boolean; confidence?: ConceptConfidence | null };
    }) => readinessService.updateConceptProgress('cs-concepts', conceptId, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['conceptWorkspace', 'cs-concepts'], updated);
      void queryClient.invalidateQueries({ queryKey: ['placementRadar'] });
    },
  });

  const toggleIncludeDistributed = () => {
    setIncludeDistributed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(DS_OPT_IN_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      if (!next && subTrackFilter === 'distributed-systems') {
        setSubTrackFilter('core-all');
      }
      return next;
    });
  };

  const handleSubTrackSelect = (nextTrack: SubTrackFilter) => {
    setSubTrackFilter(nextTrack);
    if (nextTrack === 'distributed-systems' && !includeDistributed) {
      setIncludeDistributed(true);
      try {
        window.localStorage.setItem(DS_OPT_IN_STORAGE_KEY, 'true');
      } catch {
        // Ignore storage errors
      }
    }
  };

  const filteredConcepts = useMemo(() => {
    const concepts = data?.concepts ?? [];
    return concepts.filter((item) => {
      if (item.isOptional && !includeDistributed && subTrackFilter !== 'distributed-systems') {
        return false;
      }
      if (subTrackFilter === 'core-all') {
        if (item.isOptional) return false;
      } else if (item.subTrack !== subTrackFilter) {
        return false;
      }
      if (tierFilter !== 'all' && item.level !== tierFilter) return false;
      if (rapidOnly && !item.isHighFrequencyCrashCourse) return false;
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
  }, [data?.concepts, includeDistributed, subTrackFilter, tierFilter, rapidOnly, searchQuery]);

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
          error={error instanceof Error ? error.message : 'Unable to load CS Concepts workspace'}
          onRetry={() => void refetch()}
          variant="centered"
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50/40 overflow-x-hidden">
      <div className="max-w-[1400px] mx-auto w-full pb-20 px-4 md:px-8 space-y-6">
        <div className="pt-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <WorkspaceHeader
            domain="Core CS"
            title="CS Concepts"
            coreQuestion="How strong are my OS, DBMS, Networking, and systems fundamentals?"
            icon={<Cpu size={22} />}
            accentColor="#0F766E"
          />

          <div className="flex flex-wrap items-center gap-3 self-start lg:self-auto">
            {/* Strict Core CS Progress */}
            <div className="rounded-2xl border border-teal-200 bg-white px-4 py-2.5 shadow-xs min-w-[210px]">
              <div className="flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <span>Core CS Readiness</span>
                <span className="text-teal-700 tabular-nums">
                  {data.summary.coreCompleted} / {data.summary.coreTotal} ({data.summary.coreProgressPercent}%)
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-teal-600 transition-all duration-300"
                  style={{ width: `${data.summary.coreProgressPercent}%` }}
                />
              </div>
            </div>

            {/* Optional Bonus Badge */}
            {data.summary.optionalTotal > 0 && (
              <div className="rounded-2xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-xs">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Distributed Bonus (Optional)
                </div>
                <div className="text-xs font-bold text-slate-700 mt-0.5 tabular-nums">
                  {data.summary.optionalCompleted} / {data.summary.optionalTotal} explored
                </div>
              </div>
            )}

            {/* Explicit Opt-In Switch */}
            <button
              type="button"
              role="switch"
              aria-checked={includeDistributed}
              onClick={toggleIncludeDistributed}
              className={`inline-flex items-center gap-2 rounded-2xl border px-3.5 py-2.5 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                includeDistributed
                  ? 'border-teal-300 bg-teal-50 text-teal-900'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <span
                className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                  includeDistributed ? 'border-teal-600 bg-teal-600' : 'border-slate-300 bg-white'
                }`}
              >
                {includeDistributed && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
              </span>
              Include Distributed Systems (Optional · Advanced)
            </button>
          </div>
        </div>

        {/* Informational Optional Track Banner */}
        <div className="rounded-2xl border border-teal-200/80 bg-teal-50/70 px-4 py-3 flex items-start sm:items-center gap-3 text-xs text-teal-950">
          <Info size={16} className="text-teal-700 shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />
          <p className="leading-relaxed">
            <strong>Additional deep-dive track</strong> — explore Distributed Systems if interested in backend infrastructure or senior systems roles; optional for Core CS readiness (never penalizes your Core CS radar score).
          </p>
        </div>

        <ConceptWorkspaceShell
          concepts={data.concepts}
          filteredConcepts={filteredConcepts}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchPlaceholder="Search OS, DBMS, Networking, or optional Distributed Systems..."
          flowHeading="Core Concept Breakdown"
          matrixHeading="Side-by-Side Comparison Matrix"
          benchmarkHeading="Performance & Systems Benchmarks"
          focusMinutes={20}
          focusButtonLabel="Start 20m Focus"
          interviewButtonLabel="Practice Interview"
          isUpdating={updateMutation.isPending}
          onUpdateConcept={(conceptId, patch) =>
            updateMutation.mutate({ conceptId, patch })
          }
          filterControls={
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="CS tracks">
                  {(
                    [
                      { id: 'core-all', label: 'All Core CS' },
                      { id: 'os', label: 'OS' },
                      { id: 'dbms', label: 'DBMS' },
                      { id: 'networks', label: 'Networks' },
                      { id: 'distributed-systems', label: 'Distributed Systems (Optional)' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={subTrackFilter === tab.id}
                      onClick={() => handleSubTrackSelect(tab.id)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                        subTrackFilter === tab.id
                          ? tab.id === 'distributed-systems'
                            ? 'bg-teal-700 text-white shadow-xs'
                            : 'bg-indigo-600 text-white shadow-xs'
                          : tab.id === 'distributed-systems'
                            ? 'bg-teal-50 border border-teal-200 text-teal-800 hover:bg-teal-100'
                            : 'bg-slate-100/80 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  aria-pressed={rapidOnly}
                  onClick={() => setRapidOnly((prev) => !prev)}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    rapidOnly
                      ? 'border-amber-300 bg-amber-500 text-white shadow-xs'
                      : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                  }`}
                >
                  <Zap size={13} />
                  Rapid Revision
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-1">
                  Tier:
                </span>
                {(
                  [
                    { id: 'all', label: 'All Tiers' },
                    { id: 'beginner', label: 'Beginner' },
                    { id: 'intermediate', label: 'Intermediate' },
                    { id: 'advanced', label: 'Advanced' },
                  ] as const
                ).map((tier) => (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => setTierFilter(tier.id)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors cursor-pointer ${
                      tierFilter === tier.id
                        ? 'bg-slate-800 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                    }`}
                  >
                    {tier.label}
                  </button>
                ))}
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
};

export default CSConceptsPage;
