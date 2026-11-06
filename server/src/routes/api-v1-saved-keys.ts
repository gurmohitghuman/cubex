// GET /v1/saved-keys: the saved API keys by name and where each is used, never
// a value (services/saved-key-uses.ts, shared with MCP list_saved_keys).
// ?name= narrows it to one key; ?after= pages on (next_after). 'read' scope.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { listSavedKeys } from '../services/saved-key-uses';

const router = express.Router();

// name and after take any length the request carries: each is a saved key's
// name, and a name saved before the length cap can be longer, so every listed
// key can be looked up by name and paged past.
const textParam = (v: unknown): string | undefined | null =>
  v === undefined ? undefined : typeof v === 'string' && v ? v : null;

router.get('/saved-keys', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const name = textParam(req.query.name);
    if (name === null) return res.status(400).json({ error: 'name must be a saved key name' });
    const after = textParam(req.query.after);
    if (after === null) return res.status(400).json({ error: 'after must be a saved key name (next_after)' });
    const out = listSavedKeys(req.userId!, { name, after });
    if ('fail' in out) return res.status(out.fail === 'not_found' ? 404 : 400).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('GET /v1/saved-keys error:', error);
    res.status(500).json({ error: 'Failed to list the saved keys' });
  }
});

export default router;
