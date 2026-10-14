import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { encrypt } from '../lib/crypto';
import { createSavedKey, validateSavedKey } from '../services/saved-keys';

const router = express.Router();
router.use(authenticateToken);

const validateApiKeyBody = (req: AuthRequest) => validateSavedKey((req.body ?? {}) as Record<string, unknown>);

router.get('/api-keys/suggestions', (req: AuthRequest, res) => {
  try {
    const apiKeys = db.prepare(
      'SELECT name, key_type, description FROM api_keys WHERE user_id = ? ORDER BY name',
    ).all(req.userId!) as Array<{ name: string; key_type: string; description: string | null }>;

    res.json(apiKeys.map(key => ({
      name: key.name, reference: `/${key.name}`, type: 'api_key',
      key_type: key.key_type, description: key.description,
    })));
  } catch (error) {
    console.error('Get API key suggestions error:', error);
    res.status(500).json({ error: 'Failed to fetch API key suggestions' });
  }
});

router.get('/api-keys', (req: AuthRequest, res) => {
  try {
    res.json(db.prepare(
      'SELECT id, name, key_type, description, created_at, updated_at FROM api_keys WHERE user_id = ? ORDER BY name',
    ).all(req.userId!));
  } catch (error) {
    console.error('Get API keys error:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

router.post('/api-keys', (req: AuthRequest, res) => {
  try {
    const v = validateApiKeyBody(req);
    if (typeof v === 'string') return res.status(400).json({ error: v });
    const created = createSavedKey(req.userId!, v);
    if ('fail' in created) return res.status(409).json({ error: created.message });
    res.status(201).json(created.ok);
  } catch (error) {
    console.error('Create API key error:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

router.put('/api-keys/:id', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const v = validateApiKeyBody(req);
    if (typeof v === 'string') return res.status(400).json({ error: v });

    const existing = db.prepare('SELECT id FROM api_keys WHERE id = ? AND user_id = ?')
      .get(id, req.userId!);
    if (!existing) return res.status(404).json({ error: 'API key not found' });

    const nameClash = db.prepare('SELECT id FROM api_keys WHERE name = ? AND id != ? AND user_id = ?')
      .get(v.name, id, req.userId!);
    if (nameClash) return res.status(409).json({ error: 'API key name already exists' });

    const ciphertext = encrypt(v.key_value);
    db.prepare(`
      UPDATE api_keys
      SET name = ?, key_type = ?, key_value_encrypted = ?, description = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(v.name, v.key_type, ciphertext, v.description, id, req.userId!);

    res.json(db.prepare(
      'SELECT id, name, key_type, description, created_at, updated_at FROM api_keys WHERE id = ?',
    ).get(id));
  } catch (error) {
    console.error('Update API key error:', error);
    res.status(500).json({ error: 'Failed to update API key' });
  }
});

router.delete('/api-keys/:id', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT id FROM api_keys WHERE id = ? AND user_id = ?').get(id, req.userId!);
    if (!existing) return res.status(404).json({ error: 'API key not found' });

    db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(id, req.userId!);
    res.json({ message: 'API key deleted successfully' });
  } catch (error) {
    console.error('Delete API key error:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

export default router;
