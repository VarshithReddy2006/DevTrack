import { scoreDifferential } from '@devtrack/ats-core';
import { z } from 'zod';

const bullets = z.array(z.string().max(1000)).max(100);
export const scoreDifferentialSchema = z.object({
  originalBullets: bullets,
  revisedBullets: bullets,
  targetKeywords: z.array(z.string().trim().min(1).max(80)).max(100),
}).strict().refine(input => [...input.originalBullets, ...input.revisedBullets].reduce((sum, bullet) => sum + bullet.length, 0) <= 50_000,
  'Combined bullet text must not exceed 50000 characters');

export const scoreDifferentialService = { compare: scoreDifferential };
