import express from 'express';
import runsRoutes from './http-runs';
import rerunRoutes from './http-run-rerun';
import controlRoutes from './http-control';
import jobsRoutes from './http-jobs';
import templatesRoutes from './http-templates';
import aiGenerateRoutes from './http-ai-generate';
import aiTroubleshootRoutes from './http-ai-troubleshoot';

// Composed HTTP API router. Per-feature sub-routers each stay under the 200-line cap.
const router = express.Router();
router.use(runsRoutes);
router.use(rerunRoutes);
router.use(controlRoutes);
router.use(jobsRoutes);
router.use(templatesRoutes);
router.use(aiGenerateRoutes);
router.use(aiTroubleshootRoutes);

export default router;
