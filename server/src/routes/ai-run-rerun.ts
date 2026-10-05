import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { rerunAiColumn } from '../services/ai-run-rerun';
import { runFailHttpStatus } from '../services/run-shared';
import { rerunRowGenerationConflict } from './rerun-row-generation';

// Thin wrapper over services/ai-run-rerun.ts (shared with /api/v1 and MCP).
const router = express.Router();
router.use(authenticateToken);

// Validate rowIndices if provided: array of non-negative integers, capped at
// MAX_ROWS_PER_SHEET to prevent a runaway request. Without this, [null, "abc",
// -1, 5.5] silently produced no-op writes and Array(1M).fill(0) made huge
// targets. Shared verbatim by the HTTP rerun route below it.
export function parseRowIndices(raw: unknown): { rowIndices?: number[] } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) return { error: 'rowIndices must be an array of integers.' };
  if (raw.length > MAX_ROWS_PER_SHEET) {
    return { error: `rowIndices is capped at ${MAX_ROWS_PER_SHEET} entries.` };
  }
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      return { error: `rowIndices[${i}] must be a non-negative integer.` };
    }
  }
  return { rowIndices: raw as number[] };
}

router.post('/rerun', async (req: AuthRequest, res) => {
  try {
    const { sheetId, baseColumnName, rowIndices: rawRowIndices } = req.body as {
      sheetId?: unknown; baseColumnName?: unknown; rowIndices?: unknown;
    };
    if (typeof sheetId !== 'string' || !sheetId || typeof baseColumnName !== 'string' || !baseColumnName) {
      return res.status(400).json({ error: 'sheetId and baseColumnName are required (strings).' });
    }
    const parsed = parseRowIndices(rawRowIndices);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    // Optional row_generation fence (migration 021): "Run Selected Rows" targets
    // by row_index, so a sort/CSV-replace elsewhere between the user's selection
    // and this request would re-mean every index and rerun the WRONG rows. When
    // the client sends the generation it loaded, 409 on mismatch. Omitted = skip
    // (back-compat, same posture as PUT /:id/data). Only meaningful with an
    // explicit rowIndices subset; a full rerun re-derives targets from cell state.
    if (parsed.rowIndices && parsed.rowIndices.length > 0) {
      const conflict = rerunRowGenerationConflict(sheetId, req.userId!, req.body);
      if (conflict) return res.status(409).json(conflict);
    }

    const result = await rerunAiColumn(req.userId!, {
      sheetId, baseColumnName, rowIndices: parsed.rowIndices,
    });
    if ('fail' in result) return res.status(runFailHttpStatus(result)).json({ error: result.message });

    const n = result.ok.targetCount;
    res.json({ runId: result.ok.runId, message: `Started re-running AI for ${n} rows`, targetRows: n });
  } catch (error) {
    console.error('AI re-run error:', error);
    res.status(500).json({ error: 'Failed to start AI re-run' });
  }
});

export default router;
