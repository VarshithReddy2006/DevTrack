import { useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { useSpeechDictation } from '../hooks/useSpeechDictation';
import { INTERVIEW_ANSWER_LIMIT } from '../interview';
import { LiveAudioWaveform } from './LiveAudioWaveform';

export function AnswerComposer({ pending, onAnswer }: { pending: boolean; onAnswer: (text: string) => void }) {
  const [draft, setDraft] = useState('');
  const [monitorRequested, setMonitorRequested] = useState(false);
  const dictation = useSpeechDictation(text => setDraft(previous => {
    const separator = previous && !/\s$/.test(previous) ? ' ' : '';
    return `${previous}${separator}${text}`.slice(0, INTERVIEW_ANSWER_LIMIT);
  }));
  const canSubmit = Boolean(draft.trim()) && !pending;

  return (
    <form aria-labelledby="interview-answer-heading" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5"
      onSubmit={event => {
        event.preventDefault();
        if (!canSubmit) return;
        setMonitorRequested(false);
        if (dictation.isListening) dictation.stop();
        onAnswer(draft.trim());
      }}>
      <label id="interview-answer-heading" htmlFor="interview-answer" className="block font-semibold">Your answer</label>
      <textarea id="interview-answer" rows={7} value={draft} maxLength={INTERVIEW_ANSWER_LIMIT}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.ctrlKey && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSubmit) event.currentTarget.form?.requestSubmit();
          }
        }}
        aria-describedby="interview-answer-length"
        className="w-full resize-y rounded-xl border border-slate-300 p-3 text-sm leading-relaxed text-slate-900" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="submit" disabled={!canSubmit}
          className="rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {pending ? 'Submitting…' : 'Submit answer'}
        </button>
        {!dictation.unavailableReason && (
          <button type="button" disabled={pending} onClick={() => {
            setMonitorRequested(!dictation.isListening);
            if (dictation.isListening) dictation.stop(); else dictation.start();
          }}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium">
            {dictation.isListening ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
            {dictation.isListening ? 'Stop dictation' : 'Start dictation'}
          </button>
        )}
        <p id="interview-answer-length" className="text-sm text-slate-600">
          {INTERVIEW_ANSWER_LIMIT - draft.length} characters left · Ctrl+Enter to submit
        </p>
      </div>
      <LiveAudioWaveform active={monitorRequested && dictation.isListening && !pending} />
      {dictation.unavailableReason && (
        <p className="text-sm text-slate-600" title={dictation.unavailableReason}>{dictation.unavailableReason}</p>
      )}
      {dictation.error && <p role="alert" className="text-sm text-red-700">{dictation.error}</p>}
    </form>
  );
}
