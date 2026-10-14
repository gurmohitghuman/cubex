// The app's Formula dialog: POST /:id/formula-columns creates a formula column
// (or changes one), POST /:id/formula-columns/preview shows what it gives on
// the first rows and POST /:id/formula-columns/write has AI write one from
// plain words (both only read: allowed while the sheet is busy). One
// implementation with /api/v1 and MCP (services/formula-column.ts, formula-ai.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { FORMULA_APP_WAIT_MS } from '../lib/constants';
import { runFailHttpStatus } from '../services/run-shared';
import { startFormulaColumn, type FormulaColumnInput } from '../services/formula-column';
import { previewFormulaColumn } from '../services/formula-preview';
import { waitForDerivedFill } from '../services/derived-fill';
import { formulaKind } from '../services/formula-kind';
import { writeFormula } from '../services/formula-ai';

const router = express.Router();
router.use(authenticateToken);

const inputOf = (body: unknown): FormulaColumnInput => {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return {
    formula: b.formula, column: b.column, description: b.description,
    autoRun: typeof b.autoRun === 'boolean' ? b.autoRun : undefined,
  };
};

router.post('/:id/formula-columns/preview', async (req: AuthRequest, res) => {
  try {
    const out = await previewFormulaColumn(req.userId!, req.params.id, inputOf(req.body));
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Formula column preview error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to preview the formula' });
  }
});

// { words, model? } → { formula, model, model_source, cost_usd, preview }: one
// small call to the sheet's model; nothing is saved.
router.post('/:id/formula-columns/write', async (req: AuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.words !== 'string') return res.status(400).json({ error: 'Say what the column should hold.' });
    const model = typeof b.model === 'string' && b.model.length <= 200 ? b.model : null;
    const out = await writeFormula(req.userId!, req.params.id, b.words, model);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Formula write error:', error);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't write the formula" });
  }
});

// Answers once the fill is done or after FORMULA_APP_WAIT_MS: the tab reloads
// into the values, or shows ⏳ until the fill's end reloads it.
router.post('/:id/formula-columns', async (req: AuthRequest, res) => {
  try {
    const out = await startFormulaColumn(req.userId!, req.params.id, inputOf(req.body));
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    const rec = await waitForDerivedFill(formulaKind, out.ok.id, FORMULA_APP_WAIT_MS);
    res.json({ column: out.ok.column, created: out.ok.created, status: rec?.fill_status ?? 'done' });
  } catch (error) {
    console.error('Formula column error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to save the formula column' });
  }
});

export default router;
