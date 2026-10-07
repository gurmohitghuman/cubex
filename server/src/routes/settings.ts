import express from 'express';
import openrouterRoutes from './settings-openrouter';
import apiKeysRoutes from './settings-api-keys';
import defaultModelRoutes from './settings-default-model';
import accessTokensRoutes from './settings-access-tokens';
import tregRoutes from './settings-treg';

const router = express.Router();
router.use(openrouterRoutes);
router.use(apiKeysRoutes);
router.use(defaultModelRoutes);
router.use(accessTokensRoutes);
router.use(tregRoutes);

export default router;
