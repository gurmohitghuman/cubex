import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { parseRunRequest } from './ai-run-parse';
import { startAiRun } from '../services/ai-run-start';
import { runFailHttpStatus } from '../services/run-shared';

// Thin wrapper over services/ai-run-start.ts (shared with /api/v1 and the MCP
// run_ai_column tool). Parsing/bounding stays here (ai-run-parse.ts); the run
// flow — concurrency cap, model resolution, cap txn, preview promotion,
// placeholder seeding, enqueue + rollback — lives in the service.
const router = express.Router();
router.use(authenticateToken);
router.post('/run', async (req: AuthRequest, res) => {
  try {
    const parsed = parseRunRequest(req.body);
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });

    const result = await startAiRun(req.userId!, {
      sheetId: parsed.sheetId,
      cleanColumnName: parsed.cleanColumnName,
      prompt: parsed.prompt,
      systemPrompt: parsed.systemPrompt,
      model: parsed.model,
      useOpenRouterWebSearch: parsed.useOpenRouterWebSearch,
      useWebFetch: parsed.useWebFetch,
      safeTemperature: parsed.safeTemperature,
      safeConcurrency: parsed.safeConcurrency,
      safeMaxChars: parsed.safeMaxChars,
    });
    if ('fail' in result) return res.status(runFailHttpStatus(result)).json({ error: result.message });

    res.json({ runId: result.ok.runId, message: 'AI run started and column created', reusedRows: result.ok.reusedRows });
  } catch (error) {
    console.error('Start AI run error:', error);
    res.status(500).json({ error: 'Failed to start AI run' });
  }
});
export default router;
