import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { rerunHttpColumn } from '../services/http-run-rerun';
import { runFailHttpStatus } from '../services/run-shared';
import { parseRowIndices } from './ai-run-rerun';
import { rerunRowGenerationConflict } from './rerun-row-generation';

// Thin wrapper over services/http-run-rerun.ts (shared with /api/v1 and MCP).
// Three callers, all keyed on the master/status column name:
//   - "Run All Rows"          → no rowIndices, mode != 'missing' → every row
//   - "Run Missing or Errors" → mode = 'missing'
//   - "Run Selected Rows"     → explicit rowIndices[]
const router = express.Router();
router.use(authenticateToken);

router.post('/rerun', async (req: AuthRequest, res) => {
  try {
    const { sheetId, masterColumnName, mode, rowIndices: rawRowIndices } = req.body as {
      sheetId?: unknown; masterColumnName?: unknown; mode?: unknown; rowIndices?: unknown;
    };
    if (typeof sheetId !== 'string' || !sheetId || typeof masterColumnName !== 'string' || !masterColumnName) {
      return res.status(400).json({ error: 'sheetId and masterColumnName are required (strings).' });
    }
    const parsed = parseRowIndices(rawRowIndices);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    // Optional row_generation fence: "Run Selected Rows" targets by row_index, so
    // a sort/CSV-replace elsewhere would re-mean the indices. 409 on mismatch;
    // omitted = skip (back-compat). See rerun-row-generation.ts.
    if (parsed.rowIndices && parsed.rowIndices.length > 0) {
      const conflict = rerunRowGenerationConflict(sheetId, req.userId!, req.body);
      if (conflict) return res.status(409).json(conflict);
    }

    const result = await rerunHttpColumn(req.userId!, {
      sheetId, masterColumnName,
      mode: typeof mode === 'string' ? mode : undefined,
      rowIndices: parsed.rowIndices,
    });
    if ('fail' in result) return res.status(runFailHttpStatus(result)).json({ error: result.message });

    const n = result.ok.targetCount;
    res.json({ runId: result.ok.runId, message: `Started re-running HTTP for ${n} rows`, targetRows: n });
  } catch (error) {
    console.error('HTTP re-run error:', error);
    res.status(500).json({ error: 'Failed to start HTTP re-run' });
  }
});

export default router;
