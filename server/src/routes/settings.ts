import express from 'express';
import openrouterRoutes from './settings-openrouter';
import apiKeysRoutes from './settings-api-keys';
import defaultModelRoutes from './settings-default-model';
import accessTokensRoutes from './settings-access-tokens';
import tregRoutes from './settings-treg';
import { authenticateToken } from '../middleware/auth';
import { runWebhookRoutes } from './run-webhooks-routes';
import reuseRoutes from './settings-reuse';

const router = express.Router();
router.use(openrouterRoutes);
router.use(apiKeysRoutes);
router.use(defaultModelRoutes);
router.use(accessTokensRoutes);
router.use(tregRoutes);
// "Run finished" webhooks: the signed-in account may read and change them.
router.use('/run-webhooks', authenticateToken);
router.use(runWebhookRoutes('/run-webhooks', () => (_req, _res, next) => next()));
router.use(reuseRoutes);

export default router;
