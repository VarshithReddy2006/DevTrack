import { z } from 'zod';
import type { ApiResponse } from '../types/api.types';
import axiosClient from '../utils/axiosClient';

const flagsResponse = z.union([z.array(z.string()), z.record(z.string(), z.boolean())]);

export async function getFlags(signal?: AbortSignal): Promise<Record<string, boolean>> {
  const { data } = await axiosClient.get<ApiResponse<unknown>>('/flags', { signal });
  if (!data.success) throw new Error('Could not load feature flags');

  const flags = flagsResponse.parse(data.data);
  // The backend currently returns the keys enabled for this user.
  return Array.isArray(flags) ? Object.fromEntries(flags.map(key => [key, true])) : flags;
}
