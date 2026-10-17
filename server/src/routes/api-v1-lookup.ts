// POST /v1/sheets/:id/lookup-columns: lookup_column for REST, a thin wrapper
// over the service the MCP tool uses (services/lookup-agent.ts), so the two
// surfaces can't drift. A new lookup column answers 201, a changed one or a
// preview 200; the body is the same as the tool's answer.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus } from '../services/run-shared';
import { agentLookupColumn } from '../services/lookup-agent';

const router = express.Router();

router.post('/sheets/:id/lookup-columns', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Send a JSON object.' });
    }
    const out = await agentLookupColumn(req.userId!, req.params.id, body);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.status(out.created ? 201 : 200).json(out.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/lookup-columns error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to save the lookup column' });
  }
});

export default router;
