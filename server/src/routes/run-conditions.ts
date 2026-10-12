import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { MAX_RULE_CHARS } from '../lib/run-condition';
import { checkRuleOnSheet, generateRule, ruleModel } from '../services/run-condition-ai';
import { runFailHttpStatus } from '../services/run-shared';
import { verifySheetOwnership } from '../lib/sql-helpers';

// The "Only run if" box in the AI, HTTP API and enrichment drawers and the
// auto-run dialog (services/run-condition-ai.ts): which model "Generate" uses,
// writing a rule from plain words, and checking a rule on the sheet.
const router = express.Router();
router.use(authenticateToken);

const badSheet = (res: express.Response) => res.status(400).json({ error: 'Invalid sheet id' });

// GET /api/ai/run-conditions/sheets/:id/model → { model, source } (model null: none set)
router.get('/run-conditions/sheets/:id/model', (req: AuthRequest, res) => {
  if (!UUID_PATTERN.test(req.params.id)) return badSheet(res);
  if (!verifySheetOwnership(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const picked = ruleModel(req.userId!, req.params.id);
  res.json(picked ?? { model: null, source: null });
});

// POST /api/ai/run-conditions/sheets/:id/generate { text, model? }
router.post('/run-conditions/sheets/:id/generate', async (req: AuthRequest, res) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) return badSheet(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.text !== 'string') return res.status(400).json({ error: 'Say which rows should run.' });
    const model = typeof b.model === 'string' && b.model.length <= 200 ? b.model : null;
    const out = await generateRule(req.userId!, req.params.id, b.text, model);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Run condition generate error:', error);
    res.status(500).json({ error: "Couldn't write the rule" });
  }
});

// POST /api/ai/run-conditions/sheets/:id/check { rule }
router.post('/run-conditions/sheets/:id/check', async (req: AuthRequest, res) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) return badSheet(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.rule !== 'string' || b.rule.length > MAX_RULE_CHARS) {
      return res.status(400).json({ error: `The rule must be text of at most ${MAX_RULE_CHARS} characters.` });
    }
    const out = await checkRuleOnSheet(req.userId!, req.params.id, b.rule);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Run condition check error:', error);
    res.status(500).json({ error: "Couldn't check the rule" });
  }
});

export default router;
