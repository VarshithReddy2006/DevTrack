import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { ReadinessController } from './readiness.controller.js';
import dsaRoutes from './dsa/routes/dsa.routes.js';
import roadmapRoutes from './roadmap.routes.js';
import { zkpRoutes } from './zkp.routes.js';

const router = Router();

// ZKP anonymous benchmarking & verification (verify is public for recruiters, generate uses auth inside zkp.routes)
router.use('/zkp', zkpRoutes);

router.use(authMiddleware);

router.get('/score', ReadinessController.getScore);
router.get('/snapshot', ReadinessController.getSnapshot);
router.get('/domain/:domain', ReadinessController.getDomainIntelligence);
router.post('/intent', ReadinessController.setCareerIntent);
router.post('/skill-progress', ReadinessController.setSkillProgress);

// Guidance / Career Copilot conversational routes
router.get('/guidance/threads', ReadinessController.listGuidanceThreads);
router.get('/guidance/history', ReadinessController.getGuidanceHistory);
router.post('/guidance/chat', ReadinessController.chatGuidance);
router.delete('/guidance/history', ReadinessController.clearGuidanceHistory);

// Mount DSA sub-routes under /readiness/dsa
router.use('/dsa', dsaRoutes);

// Target role roadmap generator under /readiness/roadmap
router.use('/roadmap', roadmapRoutes);

export const readinessRoutes = router;


