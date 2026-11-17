export function StreamingReply({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="rounded-xl bg-violet-50 p-4">
      <p className="text-sm font-semibold text-violet-900">Interviewer feedback</p>
      {streaming && <p role="status" className="mt-1 text-sm text-violet-800">Generating feedback…</p>}
      <p className={`mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800 ${streaming ? 'h-28 overflow-y-auto' : ''}`}
        aria-live="off" tabIndex={streaming ? 0 : undefined}>
        {text}
      </p>
    </div>
  );
}
