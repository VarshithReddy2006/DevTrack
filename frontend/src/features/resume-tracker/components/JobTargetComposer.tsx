import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { getActiveResumeProfile, submitJobTarget } from '../../../services/jobTargetsService';
import { jobTargetsKey } from '../jobTargets';

const inputClass = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900';

function validPostingUrl(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function JobTargetComposer({ userId }: { userId: string }) {
  const [mode, setMode] = useState<'text' | 'url'>('text');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [inputError, setInputError] = useState('');
  const navigate = useNavigate();
  const client = useQueryClient();
  const profile = useQuery({
    queryKey: ['job-target-resume-profile', userId],
    queryFn: ({ signal }) => getActiveResumeProfile(signal),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: submitJobTarget,
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: jobTargetsKey(userId), exact: true, refetchType: 'none' });
    },
  });
  const resumeProfileId = selectedProfileId === profile.data?.id ? selectedProfileId : '';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resumeProfileId || mutation.isPending) return;
    const value = (mode === 'url' ? url : text).trim();
    if (!value || (mode === 'url' && !validPostingUrl(value))) {
      setInputError(mode === 'url' ? 'Enter a public HTTP or HTTPS posting URL.' : 'Paste the job description.');
      return;
    }
    setInputError('');
    const input = mode === 'url' ? { resumeProfileId, jdUrl: value } : { resumeProfileId, jdText: value };
    mutation.mutate(input, {
      onSuccess: target => { void navigate(`/resume/targets/${encodeURIComponent(target.id)}`); },
    });
  }

  return (
    <form className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="new-job-target" onSubmit={submit}>
      <h2 id="new-job-target" className="text-lg font-semibold text-slate-900">New job target</h2>
      {profile.isPending && <p role="status" className="text-sm text-slate-600">Loading your resume profile…</p>}
      {profile.isError && (
        <div className="text-sm">
          <p role="alert">Couldn’t load your resume profile.</p>
          <button type="button" className="underline" onClick={() => void profile.refetch()}>Try again</button>
        </div>
      )}
      {profile.data === null && (
        <p className="text-sm text-slate-600">Add a resume in <Link className="underline" to="/resume">Resume Intelligence</Link> to get started.</p>
      )}
      {profile.data && (
        <label className="grid gap-1.5 text-sm font-medium">
          Resume profile
          <select className={inputClass} value={resumeProfileId} onChange={event => setSelectedProfileId(event.target.value)} required>
            <option value="">Select your resume profile</option>
            <option value={profile.data.id}>Active resume profile</option>
          </select>
        </label>
      )}
      <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <legend className="mb-2 font-medium">Job posting source</legend>
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="job-posting-source" checked={mode === 'text'} onChange={() => { setMode('text'); setInputError(''); }} />
          Paste description
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="job-posting-source" checked={mode === 'url'} onChange={() => { setMode('url'); setInputError(''); }} />
          Posting link
        </label>
      </fieldset>
      {mode === 'text' ? (
        <label className="grid gap-1.5 text-sm font-medium">
          Job description
          <textarea className={inputClass} value={text} rows={6} onChange={event => setText(event.target.value)} required />
        </label>
      ) : (
        <label className="grid gap-1.5 text-sm font-medium">
          Posting URL
          <input className={inputClass} type="url" value={url} placeholder="https://…" onChange={event => setUrl(event.target.value)} required />
        </label>
      )}
      {inputError && <p role="alert" className="text-sm text-red-700">{inputError}</p>}
      {mutation.isError && <p role="alert" className="text-sm text-red-700">{mutation.error.message || 'Couldn’t submit this target.'}</p>}
      <button type="submit" className="rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" disabled={!resumeProfileId || mutation.isPending}>
        {mutation.isPending ? 'Submitting…' : 'Analyze job posting'}
      </button>
    </form>
  );
}
