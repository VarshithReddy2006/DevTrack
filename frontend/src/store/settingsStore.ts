import { create } from 'zustand';
import { getSettings, updateSettings, type UserSettingsResponse } from '../services/settingsService';
import { useDashboardStore } from './dashboardStore';
import { hasPlatformChanges, isPlatformSetting, platformIds, platformPayload, platformValues, type PlatformValues } from '../features/settings/settingsContract';

interface SettingsState {
  settings: UserSettingsResponse | null;
  values: PlatformValues;
  savedValues: PlatformValues;
  versions: Record<string, number>;
  isLoading: boolean;
  isSaving: boolean;
  isDirty: boolean;
  error: string | null;
  saveError: string | null;
  saveSuccess: boolean;
  loadRequest: object | null;
  saveRequest: object | null;
  fetchSettings: () => Promise<void>;
  updateField: (id: string, value: unknown) => void;
  saveSettings: () => Promise<void>;
  discardChanges: () => void;
}

const message = (error: unknown) => error instanceof Error ? error.message : 'Request failed';

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null, values: platformValues(null), savedValues: platformValues(null), versions: {},
  isLoading: false, isSaving: false, isDirty: false, error: null, saveError: null, saveSuccess: false,
  loadRequest: null, saveRequest: null,

  fetchSettings: async () => {
    if (get().isSaving || get().isLoading) return;
    const request = {};
    const versions = get().versions;
    set({ isLoading: true, error: null, loadRequest: request });
    try {
      const settings = await getSettings();
      if (get().loadRequest !== request) return;
      const current = get();
      const savedValues = platformValues(settings);
      const values = { ...savedValues };
      for (const id of platformIds) {
        if (current.values[id] !== current.savedValues[id] || current.versions[id] !== versions[id]) values[id] = current.values[id];
      }
      set({ settings, values, savedValues, isDirty: hasPlatformChanges(values, savedValues), isLoading: false, loadRequest: null });
    } catch (error) {
      if (get().loadRequest === request) set({ error: 'Could not load settings: ' + message(error) + '. Please retry.', isLoading: false, loadRequest: null });
    }
  },

  updateField: (id, value) => {
    if (!get().settings || !isPlatformSetting(id) || typeof value !== 'string') return;
    const current = get();
    if (value === current.values[id]) return;
    const values = { ...current.values, [id]: value };
    set({ values, versions: { ...current.versions, [id]: (current.versions[id] ?? 0) + 1 }, isDirty: hasPlatformChanges(values, current.savedValues), saveError: null, saveSuccess: false });
  },

  saveSettings: async () => {
    const current = get();
    if (!current.settings || current.isSaving || !current.isDirty) return;
    const request = {};
    const versions = current.versions;
    set({ isSaving: true, saveError: null, saveSuccess: false, saveRequest: request, loadRequest: null, isLoading: false });
    try {
      const settings = await updateSettings(platformPayload(current.values, current.savedValues));
      if (get().saveRequest !== request) return;
      // A saved handle changes which platforms are connected.
      useDashboardStore.getState().invalidate();
      const latest = get();
      const savedValues = platformValues(settings);
      const values = { ...savedValues };
      for (const id of platformIds) if (latest.versions[id] !== versions[id]) values[id] = latest.values[id];
      set({ settings, values, savedValues, isDirty: hasPlatformChanges(values, savedValues), isSaving: false, saveRequest: null, saveSuccess: true });
    } catch (error) {
      if (get().saveRequest === request) set({ isSaving: false, saveRequest: null, saveError: 'Could not save settings: ' + message(error) + '. Your edits are kept. Please try again.' });
    }
  },

  discardChanges: () => {
    if (get().isSaving) return;
    // Cancel an older load too: discarding restores the last saved data locally.
    set({ values: { ...get().savedValues }, isDirty: false, saveError: null, saveSuccess: false, loadRequest: null, isLoading: false });
  },
}));
