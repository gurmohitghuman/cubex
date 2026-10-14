// POST /v1/sheets/:id/formula-columns: formula_column for REST, a thin wrapper
// over the service the MCP tool uses (services/formula-agent.ts), so the two
// surfaces can't drift. A new formula column answers 201, a changed one or a
// preview 200; the body is the same as the tool's answer. POST
// /v1/sheets/:id/formula-columns/write is write_formula (services/formula-ai.ts).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus } from '../services/run-shared';
import { agentFormulaColumn } from '../services/formula-agent';
import { writeFormula } from '../services/formula-ai';

const router = express.Router();

router.post('/sheets/:id/formula-columns', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Send a JSON object.' });
    }
    const out = await agentFormulaColumn(req.userId!, req.params.id, body);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.status(out.created ? 201 : 200).json(out.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/formula-columns error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to save the formula column' });
  }
});

// { words, model? }: one small call to the sheet's model (it spends money, so
// the run scope); nothing is saved.
router.post('/sheets/:id/formula-columns/write', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.words !== 'string') {
      return res.status(400).json({ error: 'words: say what the column should hold.' });
    }
    if (b.model !== undefined && typeof b.model !== 'string') {
      return res.status(400).json({ error: 'model must be text.' });
    }
    const out = await writeFormula(req.userId!, req.params.id, b.words, (b.model as string | undefined) ?? null);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/formula-columns/write error:', error);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't write the formula" });
  }
});

export default router;
