import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { loadResumeEditor, saveResumeVariant, variantKey, type EditorProfile, type EditorVariant, type VariantRole } from '../../../services/resumeEditorService';
import { profileBullets } from '../editor';
import { useEditorState } from '../hooks/useEditorState';
import { useLiveAtsScore } from '../hooks/useLiveAtsScore';
import { leaveEditorMessage, useUnsavedEditor } from '../hooks/useUnsavedEditor';
import { LiveScorePanel } from '../components/LiveScorePanel';
import { SaveVariantDialog } from '../components/SaveVariantDialog';
import '../editor.css';

const BulletEditor = lazy(() => import('../components/BulletEditor'));
const BulletDiff = lazy(() => import('../components/BulletDiff'));
const RevisionHistory = lazy(() => import('../../ats/components/BulletRevisionHistoryDrawer').then(module => ({ default: module.BulletRevisionHistoryDrawer })));

function Editor({ userId, profile, variants: initialVariants }: { userId: string; profile: EditorProfile; variants: EditorVariant[] }) {
  const client = useQueryClient();
  const [variants, setVariants] = useState(initialVariants);
  const initialVariant = initialVariants.find(variant => variant.variantId === profile.activeVariant || variantKey(variant) === profile.activeVariant) ?? initialVariants[0];
  const [source, setSource] = useState(initialVariant ? variantKey(initialVariant) : 'profile');
  const selectedVariant = variants.find(variant => variantKey(variant) === source);
  const [role, setRole] = useState<VariantRole>(initialVariant?.roleType ?? 'Full Stack');
  const editor = useEditorState(initialVariant?.bulletEdits?.length ? initialVariant.bulletEdits : profileBullets(profile.summary));
  const context = useMemo(() => ({ targetRole: profile.targetRole, keywords: selectedVariant?.prioritizedSkills ?? profile.selectedSkills }), [profile.targetRole, profile.selectedSkills, selectedVariant]);
  const { score, pending: scoring } = useLiveAtsScore(editor.bullets, context);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  useUnsavedEditor(editor.dirty);

  const selectSource = (next: string) => {
    if (saving || restoring) return;
    if (editor.dirty && !window.confirm(leaveEditorMessage)) return;
    const variant = variants.find(value => variantKey(value) === next);
    editor.reset(variant?.bulletEdits?.length ? variant.bulletEdits : profileBullets(profile.summary));
    setSource(next); setRole(variant?.roleType ?? 'Full Stack'); setNotice(null); setSaveError(null);
  };
  const save = async () => {
    if (saving || restoring || scoring || editor.error || !editor.dirty) return;
    setSaving(true); setSaveError(null);
    try {
      const saved = await saveResumeVariant({ roleType: role, bulletEdits: editor.bullets, clientScore: score.score, ...(selectedVariant?.jobTargetId ? { jobTargetId: selectedVariant.jobTargetId } : {}) });
      setVariants(current => [saved, ...current.filter(variant => variantKey(variant) !== variantKey(saved))]);
      setSource(variantKey(saved));
      editor.reset(saved.bulletEdits!);
      setDialogOpen(false);
      setNotice(`Saved ${saved.variantId}.${saved.atsScore ? ` Saved ATS score: ${saved.atsScore.score}/100.` : ''}`);
    } catch (error) {
      setSaveError(error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message : 'Could not save the variant. Your draft is still here.');
    } finally { setSaving(false); }
  };

  return <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-8 text-slate-900 sm:px-8">
    <header className="space-y-2">
      <Link to="/resume" className="text-sm font-medium text-violet-700 underline">Back to Resume Intelligence</Link>
      <h1 className="text-3xl font-bold tracking-tight">Resume bullet editor</h1>
      <p className="text-sm text-slate-600">Revise your wording, compare changes and save a separate variant.</p>
    </header>
    <div className="flex flex-wrap items-end gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <label className="min-w-0 flex-1 space-y-1 text-sm font-medium">Resume source<select aria-label="Resume source" value={source} onChange={event => selectSource(event.target.value)} disabled={saving || restoring} className="block w-full rounded-lg border border-slate-300 bg-white p-2">
        <option value="profile">Profile summary</option>{variants.map(variant => <option key={variantKey(variant)} value={variantKey(variant)}>{variant.roleType} · {variant.variantId}</option>)}
      </select></label>
      <span className="pb-2 text-sm text-slate-600">{editor.dirty ? 'Unsaved changes' : 'No unsaved changes'}</span>
      <button type="button" disabled={!selectedVariant || saving || restoring} onClick={() => setHistoryOpen(true)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold disabled:opacity-50">Revision History</button>
      <button ref={saveButton} type="button" disabled={!editor.dirty || Boolean(editor.error) || scoring || saving || restoring} onClick={() => { setSaveError(null); setDialogOpen(true); }} className="rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Save as variant</button>
    </div>
    {!selectedVariant && <p className="text-sm text-slate-600">Select a saved variant to view its revision history.</p>}
    {notice && <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">{notice}</p>}
    <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section aria-labelledby="bullet-editor-heading" className="min-w-0 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <h2 id="bullet-editor-heading" className="font-semibold">Your bullets</h2>
        <p id="bullet-instructions" className="text-sm text-slate-600">One bullet per line. Use headings such as # Experience to organize sections. Action verbs appear green; numbers appear blue. Weak verbs on the active line have a wavy underline. Hover or press Alt+Enter for alternatives; Escape closes suggestions.</p>
        {selectedVariant && !selectedVariant.bulletEdits?.length && <p className="text-sm text-slate-600">This variant has no saved bullet text yet. Start from your profile summary below.</p>}
        <Suspense fallback={<p role="status">Loading editor…</p>}><BulletEditor value={editor.value} readOnly={saving || restoring} onChange={value => { editor.setValue(value); setNotice(null); }} /></Suspense>
        {editor.error && <p role="alert" className="text-sm text-red-800">{editor.error}</p>}
      </section>
      <LiveScorePanel score={score} pending={scoring} error={editor.error} />
    </div>
    <Suspense fallback={<p role="status">Loading comparison…</p>}><BulletDiff original={editor.baselineDocument} current={editor.value} /></Suspense>
    {dialogOpen && <SaveVariantDialog role={role} setRole={setRole} pending={saving} error={saveError} returnFocus={saveButton} onSave={() => void save()} onClose={() => setDialogOpen(false)} />}
    {historyOpen && selectedVariant && <Suspense fallback={<p role="status">Loading revision history…</p>}><RevisionHistory key={source} userId={userId} resumeId={source} dirty={editor.dirty} onClose={() => setHistoryOpen(false)} onBusy={setRestoring} onRestored={(saved, version, section) => {
      const replace = (current: EditorVariant[]) => current.map(variant => variantKey(variant) === variantKey(saved) ? saved : variant);
      setVariants(replace);
      client.setQueryData<Awaited<ReturnType<typeof loadResumeEditor>>>(['resume-editor', userId], current => current ? { ...current, variants: replace(current.variants) } : current);
      editor.reset(saved.bulletEdits);
      setRestoring(false);
      setNotice(`Restored version ${version}${section === '*' ? '' : ` (${section} section)`} as checkpoint ${saved.bulletRevisionVersion}. Saved ATS score: ${saved.atsScore.score}/100.`);
    }} /></Suspense>}
  </div>;
}

function Workspace({ userId }: { userId: string }) {
  const query = useQuery({ queryKey: ['resume-editor', userId], queryFn: ({ signal }) => loadResumeEditor(signal), staleTime: Infinity, refetchOnWindowFocus: false, retry: false });
  if (query.isPending) return <p role="status" className="p-6">Loading resume sources…</p>;
  if (!query.data) return <section className="space-y-3 p-6"><p role="alert">Couldn’t load the resume editor.</p><button type="button" className="underline" onClick={() => void query.refetch()}>Try again</button><Link to="/resume" className="block underline">Back to Resume Intelligence</Link></section>;
  return <Editor userId={userId} profile={query.data.profile} variants={query.data.variants} />;
}

export function ResumeEditorWorkspace() {
  const { userId } = useAuth();
  return userId ? <Workspace key={userId} userId={userId} /> : null;
}
