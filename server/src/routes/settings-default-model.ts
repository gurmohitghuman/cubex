import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { setAccountDefaultModel } from '../services/ai-model-config';

const router = express.Router();
router.use(authenticateToken);

// Account-level default AI model (migration 032) — thin wrapper over
// services/ai-model-config.ts (shared with the MCP set_default_model tool).
// Sheet-level defaults override it per sheet; when neither is set, AI runs
// are rejected until the user picks a model — there is no hardcoded fallback.
// null clears the setting. Historical strictness preserved: a body WITHOUT a
// `model` key is a 400, not a clear.
router.put('/default-model', (req: AuthRequest, res) => {
  try {
    const { model } = req.body as { model?: unknown };
    if (model !== null && (typeof model !== 'string' || model.length > 200)) {
      return res.status(400).json({ error: 'Invalid model value' });
    }
    const result = setAccountDefaultModel(req.userId!, model);
    if ('fail' in result) return res.status(400).json({ error: result.message });
    res.json({ defaultAiModel: result.ok.model });
  } catch (error) {
    console.error('Update default model error:', error);
    res.status(500).json({ error: 'Failed to update default model' });
  }
});

export default router;
