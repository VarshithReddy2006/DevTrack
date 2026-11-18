import { useEffect, useRef, type RefObject } from 'react';
import { variantRoles, type VariantRole } from '../../../services/resumeEditorService';

export function SaveVariantDialog({ role, setRole, pending, error, returnFocus, onSave, onClose }: {
  role: VariantRole; setRole: (role: VariantRole) => void; pending: boolean; error: string | null;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onSave: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const trigger = returnFocus.current;
    element.showModal();
    return () => { element.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [returnFocus]);
  return <dialog ref={dialog} aria-labelledby="save-variant-title" aria-describedby="save-variant-description" className="resume-save-dialog w-[min(92vw,440px)] rounded-xl border border-slate-200 bg-white p-6 text-slate-900 shadow-xl"
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!pending) onSave(); }} className="space-y-4">
      <h2 id="save-variant-title" className="text-xl font-semibold">Save as variant</h2>
      <p id="save-variant-description" className="text-sm text-slate-600">Create a separate saved version. Choosing another role can change the keyword score.</p>
      <label className="block space-y-1 text-sm font-medium">Variant role<select autoFocus value={role} onChange={event => setRole(event.target.value as VariantRole)} disabled={pending} className="block w-full rounded-lg border border-slate-300 bg-white p-2">{variantRoles.map(value => <option key={value}>{value}</option>)}</select></label>
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      <div className="flex justify-end gap-3"><button type="button" onClick={onClose} disabled={pending} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">Cancel</button><button type="submit" disabled={pending} className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? 'Saving…' : 'Save variant'}</button></div>
    </form>
  </dialog>;
}
