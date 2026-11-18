import { createContext } from 'react';

export const EditorGuardContext = createContext<((guard: () => boolean) => () => void) | null>(null);
