import { beforeEach, describe, expect, it, vi } from 'vitest';
import axiosClient from '../utils/axiosClient';
import { fetchEvidenceClaims } from './evidenceService';

vi.mock('../utils/axiosClient', () => ({ default: { get: vi.fn() } }));

beforeEach(() => {
  vi.mocked(axiosClient.get).mockReset();
});

describe('evidenceService', () => {
  it('unwraps the claims array from the API envelope', async () => {
    vi.mocked(axiosClient.get).mockResolvedValue({ data: { success: true, data: [{ id: 'c1' }] } });
    expect(await fetchEvidenceClaims()).toEqual([{ id: 'c1' }]);
    expect(axiosClient.get).toHaveBeenCalledWith('/evidence/claims', { params: {}, signal: undefined });
  });

  it('sends only the filters that are set', async () => {
    vi.mocked(axiosClient.get).mockResolvedValue({ data: { success: true, data: [] } });
    await fetchEvidenceClaims({ verificationStatus: 'flagged', subjectType: undefined });
    expect(axiosClient.get).toHaveBeenCalledWith('/evidence/claims', { params: { verificationStatus: 'flagged' }, signal: undefined });
  });
});
