import { Router, type Request, type Response } from 'express';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { zkpVerifierService } from './zkpVerifier.service.js';
import { VerifiedClaimProof } from '../../db/models/verifiedClaimProof.model.js';
import { asyncHandler } from '../../middleware/error.js';

export const zkpRoutes = Router();

/**
 * POST /api/v2/readiness/zkp/generate
 * Authenticated candidate requests a zero-knowledge range proof of their competitive skills
 * (e.g. readinessScore >= 800 or problemsSolved >= 300) without revealing their private profile.
 */
zkpRoutes.post(
  '/generate',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.id || authReq.user?.clerkId;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: missing authenticated candidate context.',
      });
      return;
    }

    const body = req.body || {};
    const claimType = body.claimType || 'readinessScore';
    const threshold = Number(body.threshold);
    const operator = body.operator || '>=';
    const sessionNonce = body.sessionNonce;
    const customMetricValue = body.customMetricValue !== undefined ? Number(body.customMetricValue) : undefined;

    if (isNaN(threshold) || threshold < 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid threshold: must be a non-negative number.',
      });
      return;
    }

    try {
      const generated = await zkpVerifierService.generateProofForUser(userId, {
        claimType,
        threshold,
        operator,
        sessionNonce,
        customMetricValue,
      });

      res.status(200).json({
        success: true,
        proofId: generated.proofId,
        proof: generated.proof,
        publicSignals: generated.publicSignals,
        verificationKeyId: generated.verificationKeyId,
        data: generated,
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: err.message,
        message: err.message,
      });
    }
  })
);

/**
 * POST /api/v2/readiness/zkp/verify
 * Public endpoint: Any recruiter or external verifier can submit the proof object
 * and cryptographically verify the statement's truth in < 50ms without learning candidate identity.
 */
zkpRoutes.post(
  '/verify',
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body?.data && req.body.data.proof ? req.body.data : req.body;
    const { proof, publicSignals, verificationKeyId, proofId } = payload || {};

    if (!proof || !publicSignals || !verificationKeyId) {
      res.status(400).json({
        valid: false,
        verified: false,
        error: 'Invalid payload: required fields proof, publicSignals, and verificationKeyId are missing.',
      });
      return;
    }

    const result = await zkpVerifierService.verifyProof({
      proof,
      publicSignals,
      verificationKeyId,
      proofId,
    });

    res.status(200).json(result);
  })
);

/**
 * GET /api/v2/readiness/zkp/proofs/:proofId
 * Public verification lookup for registered proof metadata (anonymous, no candidate identity).
 */
zkpRoutes.get(
  '/proofs/:proofId',
  asyncHandler(async (req: Request, res: Response) => {
    const proofId = req.params.proofId as string;
    const record = await VerifiedClaimProof.findOne({ proofId })
      .select('proofId claimType operator threshold commitment sessionNonce verificationKeyId verifiedCount lastVerifiedAt expiresAt status createdAt')
      .lean()
      .exec();

    if (!record) {
      res.status(404).json({
        success: false,
        error: 'Proof record not found or expired.',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: record,
    });
  })
);

export default zkpRoutes;
