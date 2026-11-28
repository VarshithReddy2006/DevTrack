import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfileStore } from './profileStore';
import { useDashboardStore } from './dashboardStore';
import { getProfile, updateProfile } from '../services/profileService';

vi.mock('../services/profileService', () => ({
  getProfile: vi.fn(), updateProfile: vi.fn(), connectPlatform: vi.fn(), syncAllPlatforms: vi.fn(),
}));

const initial = () => ({ displayName:'Synthetic contributor', email:'synthetic@example.test', location:'Old city', techStack:['React'], socialLinks:{} });
const response = (data: unknown) => ({ data:{data} }) as Awaited<ReturnType<typeof getProfile>>;
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; }

beforeEach(() => {
  vi.resetAllMocks();
  useProfileStore.setState(useProfileStore.getInitialState(), true);
  vi.mocked(getProfile).mockResolvedValue(response(initial()));
});

describe('profile persistence', () => {
  it('marks the dashboard cache stale after a save, since saved handles change the connected platforms', async () => {
    await useProfileStore.getState().fetchProfile();
    vi.mocked(updateProfile).mockResolvedValue(response(initial()));
    useDashboardStore.getState().setData({});
    useProfileStore.getState().updateField('leetcodeUsername','');
    await useProfileStore.getState().saveProfile();
    expect(useDashboardStore.getState().lastFetchedAt).toBeNull();
  });

  it('round-trips location and added/removed tags through the save payload', async () => {
    const stored=initial();
    vi.mocked(getProfile).mockImplementation(async()=>response(structuredClone(stored)));
    vi.mocked(updateProfile).mockImplementation(async payload=>{Object.assign(stored,payload);return response(stored);});
    await useProfileStore.getState().fetchProfile();
    useProfileStore.getState().updateField('location','New city');
    useProfileStore.getState().addTechStack(' TypeScript ');
    useProfileStore.getState().addTechStack('TypeScript');
    useProfileStore.getState().removeTechStack('React');
    await useProfileStore.getState().saveProfile();
    expect(updateProfile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({location:'New city',techStack:['TypeScript']}));
    expect(useProfileStore.getState().isDirty).toBe(false);
    await useProfileStore.getState().fetchProfile();
    expect(useProfileStore.getState().profile).toMatchObject({location:'New city',techStack:['TypeScript']});
  });

  it('sends explicit empty values when location and all tags are cleared', async () => {
    await useProfileStore.getState().fetchProfile();
    vi.mocked(updateProfile).mockResolvedValue(response({...initial(),location:null,techStack:[]}));
    useProfileStore.getState().updateField('location','');
    useProfileStore.getState().removeTechStack('React');
    await useProfileStore.getState().saveProfile();
    expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({location:'',techStack:[]}));
    expect(useProfileStore.getState().profile).toMatchObject({location:'',techStack:[]});
  });

  it('keeps failed edits dirty, exposes retry feedback, and clears it after successful retry', async () => {
    await useProfileStore.getState().fetchProfile();
    vi.mocked(updateProfile).mockRejectedValueOnce(new Error('synthetic write failure')).mockResolvedValueOnce(response({...initial(),location:'New city'}));
    useProfileStore.getState().updateField('location','New city');
    await useProfileStore.getState().saveProfile();
    expect(useProfileStore.getState()).toMatchObject({isDirty:true,isSaving:false,saveError:expect.stringMatching(/try again/i)});
    expect(useProfileStore.getState().profile.location).toBe('New city');
    await useProfileStore.getState().saveProfile();
    expect(useProfileStore.getState()).toMatchObject({isDirty:false,isSaving:false,saveError:null});
  });

  it('preserves edits made during a pending save and ignores duplicate save calls', async () => {
    await useProfileStore.getState().fetchProfile();
    const pending=deferred<Awaited<ReturnType<typeof updateProfile>>>();
    vi.mocked(updateProfile).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response({...initial(),location:'Later city',techStack:['React','TypeScript']}));
    useProfileStore.getState().updateField('location','First city');
    const first=useProfileStore.getState().saveProfile();
    useProfileStore.getState().updateField('location','Later city');
    useProfileStore.getState().addTechStack('TypeScript');
    await useProfileStore.getState().saveProfile();
    expect(updateProfile).toHaveBeenCalledTimes(1);
    pending.resolve(response({...initial(),location:'First city'}));
    await first;
    expect(useProfileStore.getState()).toMatchObject({isDirty:true,isSaving:false});
    expect(useProfileStore.getState().profile).toMatchObject({location:'Later city',techStack:['React','TypeScript']});
    await useProfileStore.getState().saveProfile();
    expect(updateProfile).toHaveBeenLastCalledWith(expect.objectContaining({location:'Later city',techStack:['React','TypeScript']}));
    expect(useProfileStore.getState().isDirty).toBe(false);
  });

  it('uses normalized server values after a save with no later local edits', async () => {
    await useProfileStore.getState().fetchProfile();
    useProfileStore.getState().updateField('location',' New city ');
    vi.mocked(updateProfile).mockResolvedValue(response({...initial(),location:'New city'}));
    await useProfileStore.getState().saveProfile();
    expect(useProfileStore.getState().profile.location).toBe('New city');
  });

  it('loads legacy profiles without location or tags as empty editable values', async () => {
    vi.mocked(getProfile).mockResolvedValue(response({displayName:'Legacy contributor',email:'legacy@example.test',socialLinks:{}}));
    await useProfileStore.getState().fetchProfile();
    expect(useProfileStore.getState().profile).toMatchObject({location:'',techStack:[]});
  });

  it('does not overwrite edits with a fetch that started earlier', async () => {
    const pending=deferred<Awaited<ReturnType<typeof getProfile>>>();
    vi.mocked(getProfile).mockReturnValue(pending.promise);
    const loading=useProfileStore.getState().fetchProfile();
    useProfileStore.getState().updateField('location','Edited while loading');
    pending.resolve(response(initial()));
    await loading;
    expect(useProfileStore.getState().profile.location).toBe('Edited while loading');
    expect(useProfileStore.getState()).toMatchObject({isDirty:true,isLoading:false});
  });

  it('does not repopulate or dirty a reset profile after a delayed save', async () => {
    await useProfileStore.getState().fetchProfile();
    const pending=deferred<Awaited<ReturnType<typeof updateProfile>>>();
    vi.mocked(updateProfile).mockReturnValue(pending.promise);
    useProfileStore.getState().updateField('location','Before reset');
    const saving=useProfileStore.getState().saveProfile();
    useProfileStore.setState(useProfileStore.getInitialState(),true);
    pending.resolve(response({...initial(),location:'Before reset'}));
    await saving;
    expect(useProfileStore.getState().profile.location).toBe('');
    expect(useProfileStore.getState()).toMatchObject({isDirty:false,isSaving:false});
  });

  it('resets loading states to false and exposes failure details on sync failure', async () => {
    const { connectPlatform, syncAllPlatforms } = await import('../services/profileService');
    vi.mocked(connectPlatform).mockResolvedValue(undefined as any);
    vi.mocked(syncAllPlatforms).mockRejectedValueOnce({
      response: {
        data: {
          data: {
            results: [
              { platform: 'leetcode', success: true },
              { platform: 'codechef', success: false, error: 'CodeChef user not found' }
            ]
          }
        }
      }
    });

    useProfileStore.getState().updateField('leetcodeUsername', 'Varshithreddy8044');
    useProfileStore.getState().updateField('codechefUsername', 'VarshithReddy2006');
    useProfileStore.getState().updateField('codeforcesUsername', '');

    const result = await useProfileStore.getState().fetchAllPlatforms();
    expect(result.success).toBe(true); // partial success
    const state = useProfileStore.getState();
    expect(state.leetcode.loading).toBe(false);
    expect(state.codechef.loading).toBe(false);
    expect(state.codeforces.loading).toBe(false);
    expect(state.codechef.error).toBe('CodeChef user not found');
    expect(state.syncMessage).toContain('CodeChef user not found');
  });

  it('gracefully handles complete failure and clears loading status', async () => {
    const { connectPlatform, syncAllPlatforms } = await import('../services/profileService');
    vi.mocked(connectPlatform).mockRejectedValueOnce(new Error('Connection rejected'));
    vi.mocked(syncAllPlatforms).mockRejectedValueOnce(new Error('Network error'));

    useProfileStore.getState().updateField('leetcodeUsername', 'Varshithreddy8044');

    const result = await useProfileStore.getState().fetchAllPlatforms();
    expect(result.success).toBe(false);
    const state = useProfileStore.getState();
    expect(state.leetcode.loading).toBe(false);
    expect(state.syncState).toBe('error');
    expect(state.syncMessage).toContain('Connection failed for: leetcode');
  });
});
