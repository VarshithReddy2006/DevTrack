import { beforeEach, describe, expect, it, vi } from 'vitest';
import axiosClient from '../utils/axiosClient';
import { getCurrentStandings, setLeagueParticipation } from './leaguesService';

vi.mock('../utils/axiosClient', () => ({ default: { get: vi.fn(), put: vi.fn() } }));

const get = vi.mocked(axiosClient.get);
const put = vi.mocked(axiosClient.put);

describe('leaguesService', () => {
  beforeEach(() => {
    get.mockReset();
    put.mockReset();
  });

  it('loads the current standings and unwraps the envelope', async () => {
    const view = { participating: false, standings: [] };
    get.mockResolvedValue({ data: { success: true, data: view } });
    const signal = new AbortController().signal;

    await expect(getCurrentStandings({ signal })).resolves.toBe(view);
    expect(get).toHaveBeenCalledWith('/leagues/current', { signal });
  });

  it('throws the API message when the call is not successful', async () => {
    get.mockResolvedValue({ data: { success: false, message: 'nope' } });
    await expect(getCurrentStandings()).rejects.toThrow('nope');
  });

  it('lets a transport error (for example the endpoint not being deployed) reach the caller', async () => {
    get.mockRejectedValue(new Error('Request failed with status code 404'));
    await expect(getCurrentStandings()).rejects.toThrow('404');
  });

  it('sends the participation choice', async () => {
    put.mockResolvedValue({ data: { success: true, data: { participating: true } } });
    await expect(setLeagueParticipation(true)).resolves.toEqual({ participating: true });
    expect(put).toHaveBeenCalledWith('/leagues/participation', { participate: true });
  });
});
