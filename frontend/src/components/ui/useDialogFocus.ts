import { useCallback, useLayoutEffect, useRef, useState } from 'react';

type DialogEntry = { element: HTMLElement; opener: HTMLElement | null };

const dialogStack: DialogEntry[] = [];
const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let previousOverflow = '';

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.closest('[hidden], [inert], [aria-hidden="true"]') && !element.matches(':disabled') && element.tabIndex >= 0
  );
}

function focusFirst(dialog: HTMLElement) {
  const preferred = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]');
  const target = preferred && focusableElements(dialog).includes(preferred)
    ? preferred
    : focusableElements(dialog)[0] ?? dialog;
  target.focus();
}

/** Shared focus, keyboard, and scroll behavior for the project's modal surfaces. */
export function useDialogFocus<T extends HTMLElement>(onClose: () => void) {
  const [dialog, setDialog] = useState<T | null>(null);
  const dialogRef = useCallback((element: T | null) => setDialog(element), []);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!dialog) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry: DialogEntry = { element: dialog, opener };
    if (dialogStack.length === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    dialogStack.push(entry);
    focusFirst(dialog);

    const isTop = () => dialogStack[dialogStack.length - 1] === entry;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const elements = focusableElements(dialog);
        const first = elements[0] ?? dialog;
        const last = elements[elements.length - 1] ?? dialog;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || active === dialog || !dialog.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = dialogStack.indexOf(entry);
      if (index >= 0) dialogStack.splice(index, 1);
      if (dialogStack.length === 0) document.body.style.overflow = previousOverflow;
      const top = dialogStack[dialogStack.length - 1]?.element;
      if (top) {
        if (opener?.isConnected && top.contains(opener)) opener.focus();
        else focusFirst(top);
      } else if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, [dialog]);

  return dialogRef;
}
