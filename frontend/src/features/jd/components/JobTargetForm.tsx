import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Modal } from '../../../components/ui/Modal';
import type { JobTargetInput } from '../../../services/jobTargetsService';
import { postingTextSchema, postingUrlSchema, wordCount } from '../jobTargetValidation';
import { DomainBadgePreview } from './DomainBadgePreview';

interface JobTargetFormProps {
  resumeProfileId: string;
  onClose: () => void;
  onSubmit: (input: JobTargetInput) => Promise<unknown>;
}

// Mounted only while open so closing the dialog clears its in-memory draft.
export function JobTargetForm({ resumeProfileId, onClose, onSubmit }: JobTargetFormProps) {
  const id = useId();
  const [mode, setMode] = useState<'url' | 'text'>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const value = mode === 'url' ? url : text;
  const result = (mode === 'url' ? postingUrlSchema : postingTextSchema).safeParse(value);
  const error = (attempted || value.length > 0) && !result.success ? result.error.issues[0].message : '';

  function selectMode(next: 'url' | 'text') {
    if (lock.current) return;
    setMode(next);
    setAttempted(false);
    setSubmitError('');
  }

  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
    selectMode(next === 0 ? 'url' : 'text');
    tabs.current[next]?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !resumeProfileId) return;
    setAttempted(true);
    if (!result.success) {
      (mode === 'url' ? input.current : textarea.current)?.focus();
      return;
    }
    lock.current = true;
    setSubmitting(true);
    setSubmitError('');
    try {
      await onSubmit(mode === 'url' ? { resumeProfileId, jdUrl: result.data } : { resumeProfileId, jdText: result.data });
    } catch (cause) {
      setSubmitError(cause instanceof Error && cause.message ? cause.message : 'Couldn’t submit this target. Try again.');
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={() => { if (!lock.current) onClose(); }} title="New job target" description="Import a posting link or paste its job description.">
      <form aria-label="New job target" onSubmit={event => void submit(event)} noValidate className="max-h-[65vh] space-y-4 overflow-y-auto text-slate-900">
        <div role="tablist" aria-label="Job posting source" className="grid grid-cols-2 gap-2">
          {(['url', 'text'] as const).map((tab, index) => <button key={tab} ref={element => { tabs.current[index] = element; }}
            type="button" role="tab" id={`${id}-${tab}-tab`} aria-controls={`${id}-${tab}-panel`} aria-selected={mode === tab}
            tabIndex={mode === tab ? 0 : -1} disabled={submitting} onClick={() => selectMode(tab)} onKeyDown={event => tabKey(event, index)}
            className={`rounded-lg border px-3 py-2 text-sm font-medium ${mode === tab ? 'border-violet-700 bg-violet-50 text-violet-800' : 'border-slate-200'}`}>
            {tab === 'url' ? 'Import via URL' : 'Paste Job Description'}
          </button>)}
        </div>
        <div hidden role="tabpanel" id={`${id}-${mode === 'url' ? 'text' : 'url'}-panel`} aria-labelledby={`${id}-${mode === 'url' ? 'text' : 'url'}-tab`} />
        <div role="tabpanel" id={`${id}-${mode}-panel`} aria-labelledby={`${id}-${mode}-tab`} className="space-y-3">
          {mode === 'url' ? <>
            <label htmlFor={`${id}-url`} className="block text-sm font-medium">Posting URL</label>
            <input ref={input} data-dialog-initial-focus id={`${id}-url`} type="url" value={url} placeholder="https://jobs.lever.co/company/role"
              autoComplete="url" required disabled={submitting} aria-invalid={!!error} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
              onChange={event => { setUrl(event.target.value); setSubmitError(''); }} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <DomainBadgePreview value={url} />
            <p id={`${id}-hint`} className="text-xs text-slate-600">If the posting requires a login, use Paste Job Description.</p>
          </> : <>
            <label htmlFor={`${id}-text`} className="block text-sm font-medium">Job description</label>
            <textarea ref={textarea} id={`${id}-text`} value={text} rows={7} required disabled={submitting} aria-invalid={!!error}
              aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} onChange={event => { setText(event.target.value); setSubmitError(''); }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <p id={`${id}-hint`} className="text-xs text-slate-600">{wordCount(text)} words · minimum 100 words · maximum 50,000 characters</p>
          </>}
          {error && <p id={`${id}-error`} role="alert" className="text-sm text-red-700">{error}</p>}
        </div>
        {submitError && <p role="alert" className="text-sm text-red-700">{submitError}</p>}
        {submitting && <p role="status" className="text-sm text-slate-600">Submitting for background analysis…</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" onClick={onClose} disabled={submitting} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={submitting || !resumeProfileId} className="rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{submitting ? 'Submitting…' : 'Analyze job posting'}</button>
        </div>
      </form>
    </Modal>
  );
}
