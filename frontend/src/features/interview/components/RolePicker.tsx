import { useState } from 'react';
import { interviewRoles, type InterviewRole } from '../../../services/interviewService';
import { INTERVIEW_ROLE_LABELS } from '../interview';

export function RolePicker({ pending, onStart }: { pending: boolean; onStart: (role: InterviewRole) => void }) {
  const [role, setRole] = useState<InterviewRole>('backend');
  return (
    <form onSubmit={event => {
      event.preventDefault();
      if (!pending) onStart(role);
    }} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <fieldset className="grid gap-3 sm:grid-cols-2" disabled={pending}>
        <legend className="mb-3 text-lg font-semibold">Choose an interview role</legend>
        {interviewRoles.map(value => (
          <label key={value} className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium has-checked:border-violet-500 has-checked:bg-violet-50">
            <input type="radio" name="interview-role" value={value} checked={role === value}
              onChange={() => setRole(value)} className="shrink-0 accent-violet-700" />
            {INTERVIEW_ROLE_LABELS[value]}
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={pending} className="rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
        {pending ? 'Starting…' : 'Start interview'}
      </button>
    </form>
  );
}
