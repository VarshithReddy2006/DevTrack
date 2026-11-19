import { useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import { EditorGuardContext } from './editorNavigation';

/** BrowserRouter needs a shared guard so shell links also protect the editor draft. */
export function EditorNavigationGuard({ children }: { children: ReactNode }) {
  const navigation = useContext(UNSAFE_NavigationContext);
  const guard = useRef<{ confirm: () => boolean; index?: number } | null>(null);
  const register = useCallback((next: () => boolean) => {
    const entry = { confirm: next, index: window.history.state?.idx as number | undefined };
    guard.current = entry;
    return () => { if (guard.current === entry) guard.current = null; };
  }, []);
  // Install at the shared router boundary before BrowserRouter's parent layout
  // listener. A lazy page's later popstate listener can lose its draft first.
  useLayoutEffect(() => {
    let reverting = false;
    const pop = (event: PopStateEvent) => {
      if (reverting) { reverting = false; event.stopImmediatePropagation(); return; }
      const entry = guard.current;
      const next = event.state?.idx;
      if (!entry || typeof entry.index !== 'number' || typeof next !== 'number' || next === entry.index) return;
      if (entry.confirm()) return;
      event.stopImmediatePropagation();
      reverting = true;
      window.history.go(entry.index - next);
    };
    window.addEventListener('popstate', pop, true);
    return () => window.removeEventListener('popstate', pop, true);
  }, []);
  const guarded = useMemo(() => ({
    ...navigation,
    navigator: {
      ...navigation.navigator,
      push: (...args: Parameters<typeof navigation.navigator.push>) => {
        if (!guard.current || guard.current.confirm()) navigation.navigator.push(...args);
      },
      replace: (...args: Parameters<typeof navigation.navigator.replace>) => {
        if (!guard.current || guard.current.confirm()) navigation.navigator.replace(...args);
      },
    },
  }), [navigation]);
  return <EditorGuardContext.Provider value={register}><UNSAFE_NavigationContext.Provider value={guarded}>{children}</UNSAFE_NavigationContext.Provider></EditorGuardContext.Provider>;
}
