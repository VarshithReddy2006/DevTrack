import { Router } from 'express';
import { dsaController } from '../controller/dsa.controller.js';

const router = Router();

/**
 * @route   GET /api/readiness/dsa
 * @desc    Get comprehensive DSA intelligence for a user
 * @access  Private
 */
router.get('/', dsaController.getDSAIntelligence.bind(dsaController));

/**
 * @route   PUT /api/readiness/dsa
 * @desc    Update DSA profile data
 * @access  Private
 */
router.put('/', dsaController.updateDSAProfile.bind(dsaController));

/**
 * @route   POST /api/readiness/dsa/sync
 * @desc    Trigger platform sync and recompute DSA intelligence
 * @access  Private
 */
router.post('/sync', dsaController.syncDSAIntelligence.bind(dsaController));

/**
 * @route   GET /api/readiness/dsa/profile
 * @desc    Get DSA profile for a user
 * @access  Private
 */
router.get('/profile', dsaController.getDSAProfile.bind(dsaController));

export default router;
