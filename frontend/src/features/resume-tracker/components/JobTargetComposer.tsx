import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { getActiveResumeProfile, submitJobTarget } from '../../../services/jobTargetsService';
import { jobTargetsKey } from '../jobTargets';
import { JobTargetForm } from '../../jd/components/JobTargetForm';

const inputClass = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900';

export function JobTargetComposer({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState('');
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

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="new-job-target">
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
      <p className="text-sm text-slate-600">Import a job posting link or paste its full description.</p>
      <button type="button" onClick={() => setOpen(true)} disabled={!resumeProfileId}
        className="rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">Add job target</button>
      {open && <JobTargetForm resumeProfileId={resumeProfileId} onClose={() => setOpen(false)} onSubmit={input => mutation.mutateAsync(input, {
        onSuccess: target => {
          setOpen(false);
          void navigate(`/resume/targets/${encodeURIComponent(target.id)}`);
        },
      })} />}
    </section>
  );
}
