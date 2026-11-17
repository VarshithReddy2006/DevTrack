import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Search, ShieldCheck } from 'lucide-react';
import { EmptyState } from '../../components/shared/EmptyState';
import { EvidenceClaimRow } from '../../features/readiness/components/EvidenceClaimRow';
import { useEvidenceClaims } from '../../features/readiness/hooks/useEvidenceClaims';
import {
  SUBJECT_TYPE_LABELS,
  VERIFICATION_STATUS_LABELS,
  filterClaimsBySearch,
} from '../../features/readiness/utils/evidenceLedger';
import {
  EVIDENCE_SUBJECT_TYPES,
  VERIFICATION_STATUSES,
  type EvidenceSubjectType,
  type VerificationStatus,
} from '../../services/evidenceService';

interface ChipGroupProps<T extends string> {
  label: string;
  allLabel: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T | undefined;
  onChange: (value: T | undefined) => void;
}

function ChipGroup<T extends string>({ label, allLabel, options, labels, value, onChange }: ChipGroupProps<T>) {
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
      active ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
    }`;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <button type="button" aria-pressed={value === undefined} className={chip(value === undefined)} onClick={() => onChange(undefined)}>
        {allLabel}
      </button>
      {options.map((option) => (
        <button key={option} type="button" aria-pressed={value === option} className={chip(value === option)} onClick={() => onChange(option)}>
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

const EvidenceLedgerPage: React.FC = () => {
  const [status, setStatus] = useState<VerificationStatus | undefined>();
  const [subjectType, setSubjectType] = useState<EvidenceSubjectType | undefined>();
  const [search, setSearch] = useState('');

  const { data, isLoading, isError, refetch } = useEvidenceClaims({ verificationStatus: status, subjectType });
  const visible = useMemo(() => filterClaimsBySearch(data ?? [], search), [data, search]);
  const isFiltered = !!status || !!subjectType || search.trim() !== '';

  const clearFilters = () => {
    setStatus(undefined);
    setSubjectType(undefined);
    setSearch('');
  };

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 pb-16 md:px-0">
      <header className="flex flex-col gap-2">
        <Link to="/readiness" className="inline-flex w-fit items-center gap-1 text-xs font-semibold text-indigo-700 hover:underline">
          <ArrowLeft size={12} aria-hidden="true" /> Back to readiness
        </Link>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50">
            <ShieldCheck size={18} className="text-indigo-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-800 md:text-3xl">Evidence Ledger</h1>
            <p className="text-sm text-slate-500">Every claim behind your readiness score, with where it came from and how well it checks out.</p>
          </div>
        </div>
      </header>

      <section aria-label="Filters" className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="relative">
          <label htmlFor="evidence-search" className="sr-only">Search evidence claims</label>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            id="evidence-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search claims, sources or keys"
            className="w-full rounded-xl border border-slate-300 py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
        </div>
        <ChipGroup
          label="Verification status"
          allLabel="All statuses"
          options={VERIFICATION_STATUSES}
          labels={VERIFICATION_STATUS_LABELS}
          value={status}
          onChange={setStatus}
        />
        <ChipGroup
          label="Category"
          allLabel="All categories"
          options={EVIDENCE_SUBJECT_TYPES}
          labels={SUBJECT_TYPE_LABELS}
          value={subjectType}
          onChange={setSubjectType}
        />
      </section>

      {isLoading && (
        <div role="status" className="animate-pulse space-y-2">
          <span className="sr-only">Loading evidence claims…</span>
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-12 rounded-xl border border-slate-200 bg-slate-100" />)}
        </div>
      )}

      {isError && !isLoading && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <span>We couldn’t load your evidence claims.</span>
          <button type="button" onClick={() => void refetch()} className="rounded-lg border border-rose-300 bg-white px-3 py-1 text-xs font-semibold">
            Try again
          </button>
        </div>
      )}

      {!isLoading && !isError && data && (
        <>
          <p role="status" className="text-xs font-medium text-slate-500">
            {visible.length === 1 ? '1 claim' : `${visible.length} claims`}
          </p>
          {visible.length === 0 ? (
            <EmptyState
              size="sm"
              icon="shield"
              title={isFiltered ? 'No claims match these filters' : 'No evidence claims yet'}
              description={
                isFiltered
                  ? 'Try a different status, category or search term.'
                  : 'Claims show up here once DevTrack has something to verify, like a linked repo or a resume.'
              }
              action={isFiltered ? (
                <button type="button" onClick={clearFilters} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                  Clear filters
                </button>
              ) : undefined}
            />
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="w-full min-w-[720px] text-left">
                <caption className="sr-only">Evidence claims with their category, source, verification status, confidence and last check</caption>
                <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-3">Claim</th>
                    <th scope="col" className="px-4 py-3">Category</th>
                    <th scope="col" className="px-4 py-3">Source</th>
                    <th scope="col" className="px-4 py-3">Verification</th>
                    <th scope="col" className="px-4 py-3">Confidence</th>
                    <th scope="col" className="px-4 py-3">Last checked</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((claim) => <EvidenceClaimRow key={claim.id} claim={claim} />)}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default EvidenceLedgerPage;
