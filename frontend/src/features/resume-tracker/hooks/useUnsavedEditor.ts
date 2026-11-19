import { useContext, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { EditorGuardContext } from '../context/editorNavigation';

export const leaveEditorMessage = 'Discard your unsaved resume changes?';

export function useUnsavedEditor(dirty: boolean) {
  const register = useContext(EditorGuardContext);
  const location = useLocation();
  useEffect(() => {
    if (!dirty) return;
    if (!register) throw new Error('The resume editor needs its navigation guard provider.');
    const unregister = register(() => window.confirm(leaveEditorMessage));
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', unload);
    return () => {
      unregister();
      window.removeEventListener('beforeunload', unload);
    };
  }, [dirty, register, location.key]);
}
