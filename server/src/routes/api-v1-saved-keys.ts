// GET /v1/saved-keys: the saved API keys by name and where each is used, never
// a value (services/saved-key-uses.ts, shared with MCP list_saved_keys).
// ?name= narrows it to one key. 'read' scope.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { listSavedKeys } from '../services/saved-key-uses';

const router = express.Router();

router.get('/saved-keys', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const name = req.query.name;
    if (name !== undefined && (typeof name !== 'string' || !name || name.length > 200)) {
      return res.status(400).json({ error: 'name must be a saved key name' });
    }
    const out = listSavedKeys(req.userId!, name as string | undefined);
    if ('fail' in out) return res.status(out.fail === 'not_found' ? 404 : 400).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('GET /v1/saved-keys error:', error);
    res.status(500).json({ error: 'Failed to list the saved keys' });
  }
});

export default router;
