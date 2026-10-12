// /v1 "Only run if" rules (services/run-condition-ai.ts, the same as the
// drawers' rule box and MCP's check_run_condition / write_run_condition):
//   POST /sheets/:id/run-conditions/check     { rule }             'read'
//   POST /sheets/:id/run-conditions/generate  { text, model? }     'run' (one small AI call)
// A rule then goes to a run start as run_if.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { MAX_RULE_CHARS } from '../lib/run-condition';
import { checkRuleOnSheet, generateRule } from '../services/run-condition-ai';
import { runFailHttpStatus } from '../services/run-shared';

const router = express.Router();

router.post('/sheets/:id/run-conditions/check', requireScope('read'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.rule !== 'string' || b.rule.length > MAX_RULE_CHARS) {
      return res.status(400).json({ error: `rule must be text of at most ${MAX_RULE_CHARS} characters.` });
    }
    const out = await checkRuleOnSheet(req.userId!, req.params.id, b.rule);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/run-conditions/check error:', error);
    res.status(500).json({ error: "Couldn't check the rule" });
  }
});

router.post('/sheets/:id/run-conditions/generate', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.text !== 'string') {
      return res.status(400).json({ error: 'text is required: say which rows should run.' });
    }
    if (b.model !== undefined && (typeof b.model !== 'string' || b.model.length > 200)) {
      return res.status(400).json({ error: 'model must be a model id.' });
    }
    const out = await generateRule(req.userId!, req.params.id, b.text, (b.model as string | undefined) ?? null);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/run-conditions/generate error:', error);
    res.status(500).json({ error: "Couldn't write the rule" });
  }
});

export default router;
