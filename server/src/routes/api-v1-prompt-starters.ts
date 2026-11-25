// GET /api/v1/sheets/:id/prompt-starters: the sheet's prompt starters (services/prompt-starters-read.ts), the
// same as list_prompt_starters and the app's AI column dialog, each as run_ai_column's arguments.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { sheetPromptStarters, STARTERS_NOTE } from '../services/prompt-starters-read';

const router = express.Router();

router.get('/sheets/:id/prompt-starters', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const starters = sheetPromptStarters(req.userId!, req.params.id);
    if (!starters) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ starters, note: STARTERS_NOTE });
  } catch (error) {
    console.error('GET /v1/sheets/:id/prompt-starters error:', error);
    res.status(500).json({ error: 'Failed to list the prompt starters' });
  }
});

export default router;
