import { beforeEach, describe, expect, it, vi } from 'vitest';
import axiosClient from '../utils/axiosClient';
import {
  classifyPublishError,
  fetchPublication,
  isPublicationUnavailable,
  publishProfile,
  unpublishProfile,
} from './publicationService';

vi.mock('../utils/axiosClient', () => ({ default: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

const status = { published: false, slug: null, sections: {}, publicationVersion: 0, consentVersion: null, publishedAt: null };
const apiError = (statusCode: number, message: string) => ({ success: false, statusCode, message, code: 'X' });

beforeEach(() => {
  vi.mocked(axiosClient.get).mockReset();
  vi.mocked(axiosClient.put).mockReset();
  vi.mocked(axiosClient.delete).mockReset();
});

describe('publicationService', () => {
  it('reads the status from GET /profile/publication', async () => {
    vi.mocked(axiosClient.get).mockResolvedValue({ data: { success: true, data: status } });
    expect(await fetchPublication()).toEqual(status);
    expect(axiosClient.get).toHaveBeenCalledWith('/profile/publication', { signal: undefined });
  });

  it('publishes with PUT and the exact body the API expects', async () => {
    vi.mocked(axiosClient.put).mockResolvedValue({ data: { success: true, data: status } });
    const body = {
      slug: 'jane',
      sections: { streak: true, dsa: false, github: false, projects: false, activity: false },
      consentVersion: '2026-11',
    };
    await publishProfile(body);
    expect(axiosClient.put).toHaveBeenCalledWith('/profile/publication', body);
  });

  it('unpublishes with DELETE', async () => {
    vi.mocked(axiosClient.delete).mockResolvedValue({ data: { success: true, data: status } });
    expect(await unpublishProfile()).toEqual(status);
    expect(axiosClient.delete).toHaveBeenCalledWith('/profile/publication');
  });
});

describe('error mapping', () => {
  it('treats a 404 as the API not being there', () => {
    expect(isPublicationUnavailable(apiError(404, 'Not found'))).toBe(true);
    expect(isPublicationUnavailable(apiError(500, 'boom'))).toBe(false);
    expect(isPublicationUnavailable(new Error('network'))).toBe(false);
  });

  it('tells reserved from taken handles on a 409', () => {
    expect(classifyPublishError(apiError(409, 'This handle is reserved')).kind).toBe('reserved');
    expect(classifyPublishError(apiError(409, 'This handle is already taken')).kind).toBe('taken');
  });

  it('maps 400 to invalid and anything else to other', () => {
    expect(classifyPublishError(apiError(400, 'Invalid handle'))).toEqual({ kind: 'invalid', message: 'Invalid handle' });
    expect(classifyPublishError(apiError(500, 'boom')).kind).toBe('other');
    expect(classifyPublishError(undefined).kind).toBe('other');
  });
});
