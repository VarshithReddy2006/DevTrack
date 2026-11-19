import { useId, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Search } from 'lucide-react';
import { EvidenceVerificationBadge } from '../../readiness/components/EvidenceVerificationBadge';
import {
  evidenceSourceLabels, requirementLabels, SKILL_CATEGORIES, skillCategory,
  type ComparedSkill, type MissingSkill, type StudyPlanSkillAction,
} from '../skillGap.types';
import { SkillCategoryPill } from './SkillCategoryPill';

export interface SkillGapMatrixProps {
  /** Remounts search and mutation state when the owning target changes. */
  jobTargetId: string;
  skills: readonly ComparedSkill[];
  /** Resolve only after persistence succeeds; reject to keep the action retryable. */
  onAddToStudyPlan: (action: StudyPlanSkillAction) => Promise<void>;
}
type ActionState = 'pending' | 'added' | 'error';

function Matrix({ jobTargetId, skills, onAddToStudyPlan }: SkillGapMatrixProps) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [actions, setActions] = useState<Record<string, ActionState>>({});
  const inFlight = useRef(new Set<string>());
  const [announcement, setAnnouncement] = useState('');
  const term = search.normalize('NFKC').trim().toLowerCase();
  const visible = skills.filter(skill => `${skill.name} ${skillCategory(skill.category)}`.normalize('NFKC').toLowerCase().includes(term));

  async function add(skill: MissingSkill) {
    if (inFlight.current.has(skill.id) || actions[skill.id] === 'added' || skill.inStudyPlan) return;
    inFlight.current.add(skill.id);
    setActions(current => ({ ...current, [skill.id]: 'pending' }));
    setAnnouncement(`Adding ${skill.name} to study plan…`);
    try {
      await onAddToStudyPlan({ jobTargetId, skill: { ...skill } });
      setActions(current => ({ ...current, [skill.id]: 'added' }));
      setAnnouncement(`${skill.name} added to study plan.`);
    } catch {
      setActions(current => ({ ...current, [skill.id]: 'error' }));
      setAnnouncement('');
    } finally { inFlight.current.delete(skill.id); }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-5 rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 sm:p-6 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="text-xl font-semibold tracking-tight">Skill gap matrix</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">Compare job requirements with your skill evidence and plan what to learn next.</p>
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-search`} className="block text-sm font-medium">Search skills</label>
        <div className="relative">
          <Search aria-hidden="true" size={16} className="pointer-events-none absolute left-3 top-3 text-slate-400" />
          <input id={`${id}-search`} type="search" value={search} onChange={event => setSearch(event.target.value)}
            placeholder="Search by skill or category" className="w-full min-w-0 rounded-xl border border-slate-300 bg-transparent py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-slate-600" />
        </div>
        <p role="status" className="text-xs text-slate-500 dark:text-slate-400">Showing {visible.length} of {skills.length} skills</p>
      </div>
      <p role="status" className="sr-only">{announcement}</p>
      {skills.length === 0 ? <p className="py-5 text-sm text-slate-600 dark:text-slate-300">No skill comparison available yet.</p>
        : visible.length === 0 ? <div className="space-y-2 py-5 text-sm">
          <p>No skills match your search.</p>
          <button type="button" onClick={() => setSearch('')} className="rounded text-violet-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-violet-300">Clear search</button>
        </div> : <div className="grid min-w-0 gap-5 md:grid-cols-2">
          {(['matched', 'missing'] as const).map(status => {
            const items = visible.filter(skill => skill.status === status);
            const title = status === 'matched' ? 'Matched skills' : 'Missing skills';
            const Icon = status === 'matched' ? CheckCircle2 : CircleAlert;
            return <section key={status} aria-labelledby={`${id}-${status}`} className="min-w-0 space-y-4">
              <h3 id={`${id}-${status}`} className={`flex items-center gap-2 text-sm font-semibold ${status === 'matched' ? 'text-emerald-800 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-300'}`}>
                <Icon size={18} aria-hidden="true" />{title}<span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">{items.length}</span>
              </h3>
              {items.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400">{status === 'matched' ? 'No matched skills reported in this view.' : 'No missing skills reported in this view.'}</p>}
              {SKILL_CATEGORIES.map(category => {
                const grouped = items.filter(skill => skillCategory(skill.category) === category);
                if (grouped.length === 0) return null;
                return <div key={category} className="space-y-2">
                  <h4><SkillCategoryPill category={category} /></h4>
                  <ul aria-label={`${title}: ${category}`} className="space-y-2">
                    {grouped.map(skill => {
                      const action = actions[skill.id];
                      const added = skill.status === 'missing' && (skill.inStudyPlan || action === 'added');
                      return <li key={skill.id} className={`min-w-0 space-y-2 rounded-xl border p-3 ${skill.status === 'matched' ? 'border-emerald-100 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20' : 'border-amber-100 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/20'}`}>
                        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                          <span className="min-w-0 break-words text-sm font-semibold [overflow-wrap:anywhere]">{skill.name}</span>
                          <span className={`max-w-full shrink-0 break-words rounded-full px-2 py-0.5 text-xs font-medium ${skill.requirement === 'required' ? 'bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-200' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>{requirementLabels[skill.requirement]}</span>
                        </div>
                        {skill.status === 'matched' ? <>
                          <EvidenceVerificationBadge size="sm" status={skill.evidence.some(evidence => evidence.verified) ? 'verified' : 'unverified'} interactive={false} />
                          <p className="break-words text-xs text-slate-600 dark:text-slate-300">
                            {skill.evidence.length === 0 ? 'Sources not provided.' : `Found in: ${skill.evidence.map(evidence => `${evidenceSourceLabels[evidence.source]} (${evidence.verified ? 'verified' : 'unverified'})`).join(', ')}`}
                          </p>
                        </> : <>
                          <button type="button" disabled={action === 'pending' || added}
                            aria-busy={action === 'pending'}
                            aria-label={added ? `${skill.name} added to study plan` : `Add ${skill.name} to study plan`}
                            aria-describedby={action === 'error' ? `${id}-error-${encodeURIComponent(skill.id)}` : undefined}
                            onClick={() => void add(skill)}
                            className="rounded-lg border border-violet-200 bg-white px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-default disabled:opacity-60 dark:border-violet-700 dark:bg-slate-900 dark:text-violet-300 dark:hover:bg-slate-800">
                            {action === 'pending' ? 'Adding…' : added ? 'Added to study plan' : 'Add to study plan'}
                          </button>
                          {action === 'error' && <p id={`${id}-error-${encodeURIComponent(skill.id)}`} role="alert" className="text-xs text-rose-700 dark:text-rose-300">Couldn’t add {skill.name}. Try again.</p>}
                        </>}
                      </li>;
                    })}
                  </ul>
                </div>;
              })}
            </section>;
          })}
        </div>}
    </section>
  );
}

export function SkillGapMatrix(props: SkillGapMatrixProps) {
  return <Matrix key={props.jobTargetId} {...props} />;
}
