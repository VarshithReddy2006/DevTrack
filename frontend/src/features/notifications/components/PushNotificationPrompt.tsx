import { useId, useState } from 'react';
import { Bell, BellOff, X } from 'lucide-react';
import { useWebPush } from '../hooks/useWebPush';

const DISMISS_KEY = 'devtrack:push-prompt:dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function saveDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // storage blocked: the banner just shows again next visit
  }
}

const card = 'flex flex-col gap-3 rounded-2xl border p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between';

/** A small banner that offers 30-minute contest alerts as browser notifications. */
export function PushNotificationPrompt() {
  const { status, checking, busy, error, subscribe, unsubscribe } = useWebPush();
  const [dismissed, setDismissed] = useState(readDismissed);
  const titleId = useId();

  if (status === 'unsupported' || checking) return null;

  const dismiss = () => {
    saveDismissed();
    setDismissed(true);
  };
  const errorLine = error && <p role="alert" className="text-sm text-red-600">{error}</p>;

  if (status === 'subscribed') {
    return (
      <section aria-labelledby={titleId} className={`${card} border-emerald-200 bg-emerald-50/60`}>
        <div className="flex items-start gap-3">
          <Bell className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-zinc-900">Contest alerts are on</h2>
            <p className="text-sm text-zinc-600">This browser will notify you 30 minutes before a contest starts.</p>
            {errorLine}
          </div>
        </div>
        <button type="button" onClick={() => void unsubscribe()} disabled={busy} className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600">
          {busy ? 'Turning off…' : 'Turn off'}
        </button>
      </section>
    );
  }

  if (dismissed) return null;

  if (status === 'denied') {
    return (
      <section aria-labelledby={titleId} className={`${card} border-zinc-200 bg-white`}>
        <div className="flex items-start gap-3">
          <BellOff className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" aria-hidden="true" />
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-zinc-900">Notifications are blocked</h2>
            <p className="text-sm text-zinc-600">To get contest alerts, allow notifications for DevTrack in your browser's site settings.</p>
          </div>
        </div>
        <button type="button" onClick={dismiss} aria-label="Dismiss contest alert notice" className="self-end rounded-lg p-1.5 text-zinc-400 hover:text-zinc-600 sm:self-center focus-visible:outline-2 focus-visible:outline-violet-600">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby={titleId} className={`${card} border-violet-200 bg-violet-50/60`}>
      <div className="flex items-start gap-3">
        <Bell className="mt-0.5 h-5 w-5 shrink-0 text-[#7C5CFF]" aria-hidden="true" />
        <div>
          <h2 id={titleId} className="text-sm font-semibold text-zinc-900">Never miss a contest start</h2>
          <p className="text-sm text-zinc-600">Get a browser notification 30 minutes before each contest begins.</p>
          {errorLine}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={dismiss} disabled={busy} className="rounded-lg px-3 py-2 text-xs font-semibold text-zinc-600 hover:text-zinc-900 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600">
          Not now
        </button>
        <button type="button" onClick={() => void subscribe()} disabled={busy} className="rounded-lg bg-[#7C5CFF] px-3 py-2 text-xs font-semibold text-white hover:bg-[#6B4BEE] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600">
          {busy ? 'Turning on…' : 'Enable alerts'}
        </button>
      </div>
    </section>
  );
}
