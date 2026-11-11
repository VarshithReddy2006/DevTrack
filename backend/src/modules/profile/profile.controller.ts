// src/modules/profile/profile.controller.ts
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import * as service from './profile.service.js';
import { Types } from 'mongoose';

import { successResponse, commonErrors } from '../../shared/response.js';

export async function getProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  const profile = await service.getProfile(req.user!.id);
  if (!profile) {
    commonErrors.notFound(res, 'Profile');
    return;
  }
  successResponse(res, profile, 'Profile retrieved successfully');
}

export async function updateProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  const profile = await service.updateProfile(req.user!.id, req.body);
  if (!profile) {
    commonErrors.notFound(res, 'Profile');
    return;
  }
  successResponse(res, profile, 'Profile updated successfully');
}

export async function getConnectedPlatforms(req: AuthenticatedRequest, res: Response): Promise<void> {
  const platforms = await service.getConnectedPlatforms(req.user!.id);
  successResponse(res, platforms, 'Connected platforms retrieved successfully');
}

export async function getPlatformStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  const stats = await service.getPlatformStats(req.user!.id);
  successResponse(res, stats, 'Platform stats retrieved successfully');
}

export async function addTechStack(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { tag } = req.body;
  const techStack = await service.addTechStack(req.user!.id, tag);
  successResponse(res, { techStack }, 'Tech stack added successfully');
}

export async function removeTechStack(req: AuthenticatedRequest, res: Response): Promise<void> {
  const tag = req.params.tag as string;
  const techStack = await service.removeTechStack(req.user!.id, tag);
  successResponse(res, { techStack }, 'Tech stack removed successfully');
}

export async function connectPlatform(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { platformName, username } = req.body;
  const platform = await service.connectPlatform(req.user!.id, platformName, username);
  successResponse(res, platform, 'Platform connected successfully');
}

import { getAchievements as getDashboardAchievements } from '../dashboard/dashboard.service.js';

export async function getAchievements(req: AuthenticatedRequest, res: Response): Promise<void> {
  const dashboardAchievements = await getDashboardAchievements(req.user!.id);
  
  const unlocked = dashboardAchievements.achievements
    .filter(a => a.isUnlocked)
    .map(a => ({
      id: a.id,
      achievementTemplateId: a.id,
      name: a.title,
      description: a.description,
      icon: a.icon,
      category: a.category,
      rarity: (a.id.includes('30') || a.id.includes('500') ? 'legendary' : a.id.includes('100') ? 'epic' : a.id.includes('50') ? 'rare' : 'common'),
      unlockedAt: a.unlockedAt,
      xpReward: a.xpReward,
    }));

  const available = dashboardAchievements.achievements
    .filter(a => !a.isUnlocked)
    .map(a => ({
      id: a.id,
      name: a.title,
      description: a.description,
      icon: a.icon,
      category: a.category,
      rarity: (a.id.includes('30') || a.id.includes('500') ? 'legendary' : a.id.includes('100') ? 'epic' : a.id.includes('50') ? 'rare' : 'common'),
      xpReward: a.xpReward,
    }));
  
  successResponse(res, {
    unlocked,
    available,
  }, 'Achievements retrieved successfully');
}

import { PublicProfileService } from './publicProfile.service.js';
import { UserSettings } from '../../db/models/userSettings.model.js';
import { mapToPublicProfileDTO } from './profile.dto.js';

export async function getPublicProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { username } = req.params;
    const viewerType = req.user ? 'authenticated' : 'public';
    const viewerIp = typeof req.ip === 'string' ? req.ip : '127.0.0.1';
    
    const usernameStr = Array.isArray(username) ? username[0] : username;
    if (!usernameStr) {
      commonErrors.notFound(res, 'Public Profile');
      return;
    }

    const profile = await PublicProfileService.getPublicProfileByUsername(
      usernameStr,
      viewerIp,
      viewerType,
      req.user?.id ? new Types.ObjectId(req.user.id) : undefined
    );

    if (!profile) {
      commonErrors.notFound(res, 'Public Profile');
      return;
    }

    const settings = await UserSettings.findOne({ userId: profile.userId }).select('privacy').lean();
    if (profile.visibility !== 'public' ||
        (settings?.privacy?.profileVisibility && settings.privacy.profileVisibility !== 'public')) {
      commonErrors.notFound(res, 'Public Profile');
      return;
    }

    const dto = mapToPublicProfileDTO(profile, settings?.privacy);
    successResponse(res, dto, 'Public profile retrieved successfully');
  } catch (error) {
    if (error instanceof Error && error.message === 'Profile not found') {
      commonErrors.notFound(res, 'Public Profile');
      return;
    }
    throw error;
  }
}