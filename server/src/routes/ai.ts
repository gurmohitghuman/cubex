import express from 'express';
import readRoutes from './ai-read';
import draftRoutes from './ai-drafts';
import previewRoutes from './ai-preview';
import runStartRoutes from './ai-run-start';
import runRerunRoutes from './ai-run-rerun';
import controlRoutes from './ai-control';
import resultsRoutes from './ai-results';
import streamRoutes from './ai-stream';
import searchPlanRoutes from './ai-search-plan';

// Composed AI router. Per-feature sub-routers each stay under the 200-line cap.
const router = express.Router();
router.use(readRoutes);
router.use(draftRoutes);
router.use(previewRoutes);
router.use(runStartRoutes);
router.use(runRerunRoutes);
router.use(controlRoutes);
router.use(resultsRoutes);
router.use(streamRoutes);
router.use(searchPlanRoutes);

export default router;
