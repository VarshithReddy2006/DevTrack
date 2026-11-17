import type { InterviewTurn } from '../../../services/interviewService';
import { StreamingReply } from './StreamingReply';

export function InterviewTranscript({ turns, live }: {
  turns: InterviewTurn[];
  live?: { turnIndex: number; text: string };
}) {
  if (!turns.some((turn, index) => turn.answer || turn.feedback || live?.turnIndex === index)) return null;

  return (
    <section aria-labelledby="interview-transcript" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
      <h2 id="interview-transcript" className="text-lg font-semibold">Transcript</h2>
      <ol className="divide-y divide-slate-200">
        {turns.map((turn, index) => {
          const streaming = live?.turnIndex === index && !turn.feedback;
          if (!turn.answer && !turn.feedback && !streaming) return null;

          return (
            <li key={index} className="space-y-3 py-4">
              <p className="whitespace-pre-wrap break-words font-medium">{turn.question.prompt}</p>
              {turn.answer && (
                <div className="rounded-xl bg-slate-50 p-4">
                  <p className="text-sm font-semibold">Your answer</p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{turn.answer}</p>
                </div>
              )}
              {(turn.feedback || streaming) && <StreamingReply text={turn.feedback || live?.text || ''} streaming={streaming} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
