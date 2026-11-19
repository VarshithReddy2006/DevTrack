import { useEffect, useRef, useState } from 'react';
import { Drawer } from '../../../components/ui/Drawer';
import { Modal } from '../../../components/ui/Modal';
import type { RestoredVariant } from '../../../services/bulletRevisionService';
import { useBulletRevisionHistory, useRestoreRevision } from '../hooks/useBulletRevisionHistory';
import { previewRevisionRestore, relativeRevisionTime } from '../revisionHistory';
import { RevisionDiffViewer } from './RevisionDiffViewer';

interface Props {
  userId: string; resumeId: string; dirty: boolean; onClose: () => void;
  onBusy: (busy: boolean) => void;
  onRestored: (variant: RestoredVariant, restoredVersion: number, section: string) => void;
}
const button = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600';

export function BulletRevisionHistoryDrawer({ userId, resumeId, dirty, onClose, onBusy, onRestored }: Props) {
  const query = useBulletRevisionHistory(userId, resumeId);
  const restore = useRestoreRevision(userId, resumeId);
  const [selectedVersion, setSelected] = useState<number | null>(null);
  const [comparison, setComparison] = useState<'step' | 'restore'>('step');
  const [confirm, setConfirm] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, []);
  const history = query.data;
  const checkpoint = history?.checkpoints.find(item => item.versionNumber === selectedVersion) ?? history?.checkpoints.at(-1);
  const scope = checkpoint?.sectionId === '*' ? 'all resume sections' : `the ${checkpoint?.sectionId} section only`;
  const before = comparison === 'restore' ? history?.currentBullets : checkpoint?.before;
  const after = checkpoint && history ? (comparison === 'restore' ? previewRevisionRestore(history.currentBullets, checkpoint) : checkpoint.after) : undefined;
  const close = () => { if (!pending.current) onClose(); };
  const cancel = () => { if (!pending.current) setConfirm(false); };
  async function applyRestore() {
    if (!history || !checkpoint || pending.current) return;
    pending.current = true; onBusy(true); setFailure(null);
    try {
      const saved = await restore.mutateAsync({ version: checkpoint.versionNumber, expectedVersion: history.currentVersion });
      if (mounted.current) { onBusy(false); onRestored(saved, checkpoint.versionNumber, checkpoint.sectionId); setConfirm(false); onClose(); }
    } catch (error) {
      if (mounted.current) {
        setConfirm(false);
        setFailure(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 409
          ? 'This resume changed in another session. Refresh history before restoring. Your editor draft is unchanged.'
          : 'Could not confirm the restore. Your editor draft is unchanged; refresh history before trying again.');
      }
    } finally {
      pending.current = false;
      if (mounted.current) onBusy(false);
    }
  }
  return <>
    <Drawer open onClose={close} title="Revision history" className="max-w-5xl! bg-white! text-slate-900">
      <div className="space-y-4 p-4 sm:p-6" aria-busy={restore.isPending}>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-xl text-sm text-slate-600">Saved checkpoints for this variant. Scores are the values recorded at each save; the server retains up to 50 revisions.</p><button type="button" className={button} disabled={query.isFetching || restore.isPending} onClick={() => { setFailure(null); void query.refetch(); }}>Refresh history</button></div>
        {query.isPending && <p role="status">Loading revision history…</p>}
        {query.isError && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-900">Couldn’t load trustworthy revision history. Refresh to try again. Your editor draft is unchanged.</div>}
        {failure && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{failure}</p>}
        {restore.isPending && <p role="status" className="rounded-lg bg-violet-50 p-3 text-sm text-violet-900">Restoring checkpoint… Keep this view open until the server confirms it.</p>}
        {history && history.checkpoints.length === 0 && <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">No saved revisions yet. Existing variant text remains in the editor.</p>}
        {history && !query.isError && checkpoint && before && after && <div className="grid min-w-0 gap-5 md:grid-cols-[15rem_minmax(0,1fr)]">
          <section aria-label="Saved revisions" className="min-w-0"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Newest first</h3><ol className="max-h-64 space-y-2 overflow-y-auto md:max-h-[65vh]">
            {[...history.checkpoints].reverse().map(item => <li key={item.versionNumber}><button type="button" disabled={restore.isPending} aria-pressed={checkpoint.versionNumber === item.versionNumber} onClick={() => { setSelected(item.versionNumber); setFailure(null); }} className={`w-full rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-violet-600 ${checkpoint.versionNumber === item.versionNumber ? 'border-violet-500 bg-violet-50' : 'border-slate-200 bg-white'}`}>
              <span className="flex items-center justify-between gap-2"><strong className="text-sm">Version {item.versionNumber}</strong><span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-800">ATS {item.atsScore}/100</span></span>
              <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()} className="mt-2 block text-xs text-slate-600">{relativeRevisionTime(item.createdAt, now)}</time>
              <span className="mt-1 block text-xs text-slate-600">{item.sectionId === '*' ? 'All sections' : item.sectionId}{item.versionNumber === history.currentVersion ? ' · Current' : ''}{item.restoredFrom !== undefined ? ` · Restored from v${item.restoredFrom}` : ''}</span>
            </button></li>)}
          </ol></section>
          <section className="min-w-0 space-y-4" aria-label="Selected revision">
            <div><h3 className="font-semibold">Version {checkpoint.versionNumber}</h3><p className="mt-1 text-xs text-slate-600">{new Date(checkpoint.createdAt).toLocaleString()} · Recorded ATS score {checkpoint.atsScore}/100</p></div>
            <div role="group" aria-label="Difference comparison" className="flex flex-wrap gap-2">
              <button type="button" className={button} aria-pressed={comparison === 'step'} onClick={() => setComparison('step')}>Checkpoint changes</button>
              <button type="button" className={button} aria-pressed={comparison === 'restore'} onClick={() => setComparison('restore')}>Restore impact</button>
            </div>
            <p className="text-sm text-slate-600">{comparison === 'step' ? 'Changes made by this saved checkpoint.' : `What restoring would change in the latest saved variant. Restores ${scope}.`}</p>
            <RevisionDiffViewer key={`${checkpoint.versionNumber}:${comparison}`} before={before} after={after} />
            <div className="space-y-2 border-t border-slate-200 pt-4"><p className="text-sm">Restore {scope}.{checkpoint.sectionId !== '*' && ' Other currently saved sections stay unchanged.'}{dirty && ' Your unsaved editor draft will be replaced only after confirmation.'}</p>
              <button type="button" className="rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={Boolean(failure) || query.isFetching || restore.isPending || (checkpoint.versionNumber === history.currentVersion && !dirty)} onClick={() => setConfirm(true)}>{checkpoint.versionNumber === history.currentVersion && !dirty ? 'Current version' : 'Restore this version'}</button>
            </div>
          </section>
        </div>}
      </div>
    </Drawer>
    <Modal open={confirm} onClose={cancel} title={`Restore version ${checkpoint?.versionNumber}?`} description={`Restores ${scope}.${checkpoint?.sectionId !== '*' ? ' Other saved sections stay unchanged.' : ''}${dirty ? ' This replaces your unsaved editor draft.' : ''}`}>
      <p className="text-sm text-slate-600">The server checks the current version and records the restore as a new checkpoint.</p>
      <div className="mt-4 flex justify-end gap-2"><button type="button" data-dialog-initial-focus className={button} disabled={restore.isPending} onClick={cancel}>Keep current draft</button><button type="button" className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={restore.isPending} onClick={() => void applyRestore()}>{restore.isPending ? 'Restoring…' : 'Confirm restore'}</button></div>
    </Modal>
  </>;
}
