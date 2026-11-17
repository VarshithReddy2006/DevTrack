// src/modules/profile/profile.routes.ts
import { Router } from 'express';
import { asyncHandler, authMiddleware, validateBody } from '../../middleware/index.js';
import * as controller from './profile.controller.js';
import * as publication from './publication.controller.js';
import { getPublicOgImage } from './ogImage.controller.js';
import * as dossier from './dossier.controller.js';
import { publishProfileSchema } from './publication.schemas.js';
import { z } from 'zod';

const router = Router();

const profileUpdateSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).optional(),
  timezone: z.string().optional(),
  roleTitle: z.string().max(100).nullable().optional(),
  location: z.string().trim().max(100).nullable().optional(),
  techStack: z.array(z.string().trim().min(1)).optional(),
  targetRole: z.string().max(100).nullable().optional(),
  targetCompanies: z.array(z.string()).optional(),
  socialLinks: z.object({
    github: z.string().nullable().optional(),
    linkedin: z.string().nullable().optional(),
    twitter: z.string().nullable().optional(),
    portfolio: z.string().nullable().optional(),
    leetcode: z.string().nullable().optional(),
    codeforces: z.string().nullable().optional(),
    codechef: z.string().nullable().optional(),
  }).optional(),
});

const techStackSchema = z.object({
  tag: z.string().min(1),
});

router.get('/', authMiddleware, asyncHandler(controller.getProfile));
router.patch('/', authMiddleware, validateBody(profileUpdateSchema), asyncHandler(controller.updateProfile));
router.get('/platforms', authMiddleware, asyncHandler(controller.getConnectedPlatforms));
router.post('/platforms/connect', authMiddleware, validateBody(z.object({
  platformName: z.string().min(1),
  username: z.string().min(1),
})), asyncHandler(controller.connectPlatform));
router.get('/platforms/stats', authMiddleware, asyncHandler(controller.getPlatformStats));
router.get('/achievements', authMiddleware, asyncHandler(controller.getAchievements));
router.post('/tech-stack', authMiddleware, validateBody(techStackSchema), asyncHandler(controller.addTechStack));
router.delete('/tech-stack/:tag', authMiddleware, asyncHandler(controller.removeTechStack));
router.get('/publication', authMiddleware, asyncHandler(publication.getPublication));
router.put('/publication', authMiddleware, validateBody(publishProfileSchema), asyncHandler(publication.publishProfile));
router.delete('/publication', authMiddleware, asyncHandler(publication.unpublishProfile));
router.post('/dossier', authMiddleware, asyncHandler(dossier.requestDossierPdf));
router.get('/dossier', authMiddleware, asyncHandler(dossier.getDossierPdfStatus));
// Authorised by its HMAC signature, not a session, so it can be opened from a plain link.
router.get('/dossier/download', asyncHandler(dossier.downloadDossierPdf));
router.get('/public/:username', asyncHandler(controller.getPublicProfile as any));
router.get('/public/:username/og.png', asyncHandler(getPublicOgImage));

export default router;
