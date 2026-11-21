import { useEffect, useRef, useState } from 'react';

type Status = 'starting' | 'live' | 'paused' | 'error' | 'unsupported';
type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

export function useAudioVisualizer({ active, stream }: { active: boolean; stream?: MediaStream }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resumeRef = useRef<(() => void) | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>('starting');
  const [error, setError] = useState('');
  const [lowVolume, setLowVolume] = useState(false);

  useEffect(() => {
    if (!active) return;
    let disposed = false, frame = 0, lowSince: number | null = null, warned = false, lastPaint = -Infinity;
    let media: MediaStream | undefined, context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined, analyser: AnalyserNode | undefined;
    const owned = !stream;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const Constructor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    const tracks: MediaStreamTrack[] = [];

    function clearWarning() {
      lowSince = null;
      if (warned) { warned = false; setLowVolume(false); }
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', visibility);
      tracks.forEach(track => track.removeEventListener('ended', ended));
      source?.disconnect(); analyser?.disconnect();
      context?.removeEventListener('statechange', stateChanged);
      if (context && context.state !== 'closed') void context.close().catch(() => {});
      if (owned) media?.getTracks().forEach(track => track.stop());
      resumeRef.current = undefined;
    }
    function fail(message: string) {
      if (disposed) return;
      setError(message); setStatus('error'); clearWarning(); dispose();
    }
    function ended() { fail('Microphone disconnected. You can keep typing or retry the audio monitor.'); }
    function visibility() {
      cancelAnimationFrame(frame); clearWarning();
      if (!disposed && !document.hidden && context?.state === 'running') frame = requestAnimationFrame(draw);
    }
    function stateChanged() {
      if (disposed) return;
      if (context?.state === 'closed') { fail('Audio monitor stopped. You can keep typing or retry.'); return; }
      setStatus(context?.state === 'running' ? 'live' : 'paused'); visibility();
    }
    let frequencies: Uint8Array<ArrayBuffer>, samples: Float32Array<ArrayBuffer>;
    function draw(now: number) {
      if (disposed || !analyser || document.hidden || context?.state !== 'running') return;
      analyser.getByteFrequencyData(frequencies); analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const db = 20 * Math.log10(Math.max(Math.sqrt(energy / samples.length), 1e-8));
      if (db < -50) {
        lowSince ??= now;
        if (!warned && now - lowSince > 5000) { warned = true; setLowVolume(true); }
      } else clearWarning();
      const canvas = canvasRef.current, paint = canvas?.getContext('2d');
      if (canvas && paint && (!reduced?.matches || now - lastPaint >= 100)) {
        lastPaint = now; paint.clearRect(0, 0, canvas.width, canvas.height);
        const step = canvas.width / 32, bins = frequencies.length / 32;
        paint.fillStyle = '#6d28d9';
        for (let bar = 0; bar < 32; bar++) {
          let peak = 0;
          for (let bin = Math.floor(bar * bins); bin < Math.floor((bar + 1) * bins); bin++) peak = Math.max(peak, frequencies[bin]);
          const idle = reduced?.matches ? 3 : 3 + 2 * (1 + Math.sin(now / 450 + bar / 3));
          const height = db < -50 ? idle : Math.max(3, peak / 255 * (canvas.height - 12));
          paint.fillRect(bar * step + 2, (canvas.height - height) / 2, Math.max(1, step - 4), height);
        }
      }
      frame = requestAnimationFrame(draw);
    }
    async function connect() {
      setError(''); setStatus('starting'); setLowVolume(false);
      if (!Constructor || (!stream && !navigator.mediaDevices?.getUserMedia)) { setStatus('unsupported'); return; }
      try {
        media = stream ?? await navigator.mediaDevices.getUserMedia({ audio: true });
        if (disposed) { if (owned) media.getTracks().forEach(track => track.stop()); return; }
        tracks.push(...media.getAudioTracks());
        if (!tracks.some(track => track.readyState === 'live')) { fail('No active microphone signal. You can keep typing or retry.'); return; }
        context = new Constructor(); source = context.createMediaStreamSource(media); analyser = context.createAnalyser();
        analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.75;
        frequencies = new Uint8Array(analyser.frequencyBinCount); samples = new Float32Array(analyser.fftSize);
        source.connect(analyser); // Never connect microphone audio to the speakers.
        tracks.forEach(track => track.addEventListener('ended', ended));
        context.addEventListener('statechange', stateChanged);
        document.addEventListener('visibilitychange', visibility);
        resumeRef.current = () => { void context?.resume().catch(() => fail('Could not resume the audio monitor. You can keep typing or retry.')); };
        await context.resume();
        if (!disposed) stateChanged();
      } catch (cause) {
        const denied = cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
        fail(denied ? 'Microphone access was denied. You can keep typing or retry after allowing access.' : 'Could not start the audio monitor. You can keep typing or retry.');
      }
    }
    void connect();
    return dispose;
  }, [active, stream, attempt]);

  return { canvasRef, status, error, lowVolume: active && lowVolume,
    retry: () => setAttempt(value => value + 1), resume: () => resumeRef.current?.() };
}
