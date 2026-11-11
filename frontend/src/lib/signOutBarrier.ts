let pending: Promise<void> | null = null;
let release: (() => void) | null = null;

export function beginSignOut(): boolean {
  if (pending) return false;
  pending = new Promise<void>(resolve => { release = resolve; });
  return true;
}

export function finishSignOut() {
  release?.();
  release = null;
  pending = null;
}

export async function waitForSignOut() {
  await pending;
}
