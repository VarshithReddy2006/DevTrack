import { useEffect, useRef, useState } from 'react';
import { AmbientEngine, type AmbientPreset } from '../audio/ambientEngine';

const presets = [
  { value: 'off', label: 'Off' },
  { value: 'rain', label: 'Rain' },
  { value: 'white-noise', label: 'White Noise' },
  { value: 'lo-fi', label: 'Lo-Fi' },
] as const;

export function AmbientSoundControl({ running }: { running: boolean }) {
  const [preset, setPreset] = useState<AmbientPreset | 'off'>('off');
  const [volume, setVolume] = useState(0.4);
  const [error, setError] = useState(false);
  const engine = useRef<AmbientEngine | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const current = engine.current;
    if (!current) return;
    const change = ++request.current;
    void current.setActive(running).catch(() => {
      if (request.current === change) setError(true);
    });
  }, [running]);

  useEffect(() => () => {
    request.current++;
    engine.current?.stop();
    engine.current = null;
  }, []);

  function select(next: AmbientPreset | 'off') {
    const change = ++request.current;
    setError(false);
    setPreset(next);

    if (next === 'off') {
      engine.current?.stop();
      engine.current = null;
      return;
    }

    try {
      engine.current ??= new AmbientEngine();
      void engine.current.play(next, volume, running).catch(() => {
        if (request.current === change) setError(true);
      });
    } catch {
      setError(true);
    }
  }

  return (
    <fieldset className="relative z-10 mb-6 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-slate-700">
      <legend className="px-1 text-xs font-semibold">Ambient sound</legend>
      <div className="flex flex-wrap gap-1.5">
        {presets.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={preset === value}
            onClick={() => select(value)}
            className="rounded-full px-3 py-1.5 text-xs font-semibold hover:bg-violet-50 focus-visible:outline-2 focus-visible:outline-violet-600 aria-pressed:bg-violet-100 aria-pressed:text-violet-800"
          >
            {label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs font-semibold">
        Volume
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(volume * 100)}
          onChange={(event) => {
            const next = Number(event.currentTarget.value) / 100;
            setVolume(next);
            engine.current?.setVolume(next);
          }}
          className="w-24 accent-violet-600"
        />
      </label>
      {error && <p role="status" className="text-xs text-rose-700">Audio could not start. Select a preset to try again.</p>}
      {!error && preset !== 'off' && !running && (
        <p className="text-xs text-slate-600">Plays while the timer is running.</p>
      )}
    </fieldset>
  );
}
