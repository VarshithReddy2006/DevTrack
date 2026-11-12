import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../../../middleware/auth.js';
import { dsaService } from '../service/dsa.service.js';
import { GetDSAIntelligenceQuerySchema, DSAIntelligenceResponseSchema, UpdateDSAProfileSchema } from '../dto/dsa.dto.js';

export class DSAController {
  /**
   * GET /api/readiness/dsa
   * Get comprehensive DSA intelligence for a user
   */
  async getDSAIntelligence(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // Validate query parameters
      const query = GetDSAIntelligenceQuerySchema.parse(req.query);

      // Generate DSA intelligence
      const intelligence = await dsaService.generateDSAIntelligence({
        userId: req.user!.id,
        platform: query.platform,
      });

      // Validate response
      const validatedResponse = DSAIntelligenceResponseSchema.parse(intelligence);

      res.json({
        success: true,
        data: validatedResponse,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/readiness/dsa
   * Update DSA profile data
   */
  async updateDSAProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { platform, ...data } = UpdateDSAProfileSchema.parse(req.body);
      await dsaService.updateDSAProfile(req.user!.id, platform, data);

      res.json({
        success: true,
        message: 'DSA profile updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/readiness/dsa/profile
   * Get DSA profile for a user
   */
  async getDSAProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { platform } = GetDSAIntelligenceQuerySchema.parse(req.query);
      const profile = await dsaService.getDSAProfile(req.user!.id, platform);

      res.json({
        success: true,
        data: profile,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const dsaController = new DSAController();
