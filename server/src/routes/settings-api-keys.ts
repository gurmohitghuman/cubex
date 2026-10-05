import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { API_KEY_NAME_PATTERN, MIN_API_KEY_VALUE_LENGTH } from '../lib/constants';
import { encrypt } from '../lib/crypto';

const router = express.Router();
router.use(authenticateToken);

const validateApiKeyBody = (req: AuthRequest): string | {
  name: string; key_type: string; key_value: string; description: string | null;
} => {
  const { name, key_type, key_value, description } = req.body as {
    name?: unknown; key_type?: unknown; key_value?: unknown; description?: unknown;
  };
  if (typeof name !== 'string' || !name.trim()) return 'API key name is required';
  const trimmedName = name.trim();
  if (!API_KEY_NAME_PATTERN.test(trimmedName)) {
    return 'API key name can only contain letters, numbers, underscores, and hyphens';
  }
  if (typeof key_type !== 'string' || !['bearer', 'api_key', 'custom'].includes(key_type)) {
    return 'Invalid key type. Must be bearer, api_key, or custom';
  }
  if (typeof key_value !== 'string' || !key_value.trim()) return 'API key value is required';
  if (key_value.trim().length < MIN_API_KEY_VALUE_LENGTH) {
    return `API key value must be at least ${MIN_API_KEY_VALUE_LENGTH} characters long`;
  }
  return {
    name: trimmedName, key_type, key_value: key_value.trim(),
    description: (typeof description === 'string' ? description.trim() : '') || null,
  };
};

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

    const existing = db.prepare('SELECT id FROM api_keys WHERE name = ? AND user_id = ?')
      .get(v.name, req.userId!);
    if (existing) return res.status(409).json({ error: 'API key name already exists' });

    const id = `api_key_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Stored encrypted only (lib/crypto.ts); the plaintext never touches the DB.
    const ciphertext = encrypt(v.key_value);
    db.prepare(`
      INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.userId!, v.name, v.key_type, ciphertext, v.description);

    res.status(201).json(db.prepare(
      'SELECT id, name, key_type, description, created_at, updated_at FROM api_keys WHERE id = ?',
    ).get(id));
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
