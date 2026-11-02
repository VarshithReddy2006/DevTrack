import { useProgressionStore } from '../store/progressionStore';
import { useRIEStore } from '../runtime-intelligence/rieStore';
import { setNotificationAccount } from '../store/appStateStore';
import { waitForSignOut } from './signOutBarrier';

// Each tab remembers its last Clerk identity. Reloading on a change destroys
// all old in-memory stores, subscribers, pending requests and query caches.
const TAB_ACCOUNT_KEY = 'devtrack:tab-account';
const SIGNED_OUT = ':signed-out:';
let loadedIdentity: string | undefined;

export async function prepareAccount(userId: string | null, reload = () => window.location.reload(), isCurrent = () => true): Promise<boolean> {
  const identity = userId ?? SIGNED_OUT;
  let previous: string | null = null;
  try { previous = sessionStorage.getItem(TAB_ACCOUNT_KEY); } catch { /* In-memory identity still protects this document. */ }
  if ((previous !== null && previous !== identity) || (loadedIdentity !== undefined && loadedIdentity !== identity)) {
    if (!userId) await waitForSignOut();
    if (!isCurrent()) return false;
    try {
      sessionStorage.setItem(TAB_ACCOUNT_KEY, identity);
      sessionStorage.removeItem('devtrack:reconciliation:sequence');
    } catch { /* A reload still discards this document's state. */ }
    reload();
    return false;
  }
  try { sessionStorage.setItem(TAB_ACCOUNT_KEY, identity); } catch { /* Storage is optional. */ }
  loadedIdentity = identity;
  setNotificationAccount(userId);
  if (userId) {
    const suffix = encodeURIComponent(userId);
    useProgressionStore.persist.setOptions({ name: `mission-storage:${suffix}` });
    useRIEStore.persist.setOptions({ name: `rie-storage:${suffix}` });
    await Promise.all([useProgressionStore.persist.rehydrate(), useRIEStore.persist.rehydrate()]);
  }
  return true;
}
