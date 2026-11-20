import { useAudioVisualizer } from '../hooks/useAudioVisualizer';

export function LiveAudioWaveform({ active, stream }: { active: boolean; stream?: MediaStream }) {
  const audio = useAudioVisualizer({ active, stream });
  if (!active) return null;
  return (
    <section aria-label="Microphone monitor" className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p role="status" className="text-slate-700">
          {audio.status === 'live' ? 'Microphone active · live input level'
            : audio.status === 'paused' ? 'Audio monitor paused'
              : audio.status === 'unsupported' ? 'Audio visualization is unavailable in this browser. You can keep typing.'
                : audio.status === 'error' ? audio.error : 'Preparing microphone monitor…'}
        </p>
        {(audio.status === 'error' || audio.status === 'paused') && (
          <button type="button" onClick={audio.status === 'paused' ? audio.resume : audio.retry}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium">
            {audio.status === 'paused' ? 'Resume audio monitor' : 'Retry audio monitor'}
          </button>
        )}
      </div>
      <canvas ref={audio.canvasRef} width={640} height={80} role="img" aria-label="32 frequency bars showing microphone input"
        className="mt-2 h-20 w-full" />
      {audio.lowVolume && <p role="status" className="mt-2 text-sm text-amber-800">
        Very low microphone input for over 5 seconds (below −50 dBFS). Check your microphone or move closer.
      </p>}
    </section>
  );
}
