import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { MAX_TEMPLATE_NAME_LENGTH } from '../lib/constants';

const router = express.Router();

const validateTemplateName = (raw: unknown): string | { name: string } => {
  if (typeof raw !== 'string') return 'Template name cannot be empty';
  const trimmed = raw.trim();
  if (!trimmed) return 'Template name cannot be empty';
  if (trimmed.length > MAX_TEMPLATE_NAME_LENGTH) {
    return `Template name must be ${MAX_TEMPLATE_NAME_LENGTH} characters or less`;
  }
  return { name: trimmed };
};

router.get('/templates', authenticateToken, (req: AuthRequest, res) => {
  try {
    const templates = db.prepare(`
      SELECT * FROM http_api_templates
      WHERE user_id = ? AND is_draft = 0
      ORDER BY usage_count DESC, created_at DESC
    `).all(req.userId!);
    res.json(templates);
  } catch (error: any) {
    console.error('Get templates error:', error);
    res.status(500).json({ error: 'Failed to get templates' });
  }
});

router.get('/templates/:id', authenticateToken, (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const template = db.prepare('SELECT * FROM http_api_templates WHERE id = ? AND user_id = ?')
      .get(id, req.userId!);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (error: any) {
    console.error('Get template error:', error);
    res.status(500).json({ error: 'Failed to get template' });
  }
});

router.post('/templates', authenticateToken, (req: AuthRequest, res) => {
  try {
    const { name, description, config, tags, is_draft } = req.body;
    if (!config) return res.status(400).json({ error: 'Name and config are required' });
    const v = validateTemplateName(name);
    if (typeof v === 'string') return res.status(400).json({ error: v });

    const dup = db.prepare('SELECT 1 FROM http_api_templates WHERE user_id = ? AND name = ? LIMIT 1')
      .get(req.userId!, v.name);
    if (dup) return res.status(400).json({ error: `A template named "${v.name}" already exists` });

    const templateId = uuidv4();
    const configStr = typeof config === 'string' ? config : JSON.stringify(config);
    const tagsStr = tags == null ? null : (typeof tags === 'string' ? tags : JSON.stringify(tags));

    db.prepare(`
      INSERT INTO http_api_templates (id, user_id, name, description, config, tags, is_draft, usage_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(templateId, req.userId!, v.name, (typeof description === 'string' ? description : null), configStr, tagsStr, is_draft ? 1 : 0);

    res.json(db.prepare('SELECT * FROM http_api_templates WHERE id = ?').get(templateId));
  } catch (error: any) {
    console.error('Create template error:', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

router.put('/templates/:id', authenticateToken, (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const body = req.body ?? {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

    // Partial update: only touch columns the caller actually sent. Omitted fields
    // are left untouched (a PUT of just { name } must not null config/tags/is_draft).
    const sets: string[] = [];
    const vals: any[] = [];

    if (has('name')) {
      const v = validateTemplateName(body.name);
      if (typeof v === 'string') return res.status(400).json({ error: v });
      const dup = db.prepare(
        'SELECT 1 FROM http_api_templates WHERE user_id = ? AND name = ? AND id != ? LIMIT 1',
      ).get(req.userId!, v.name, id);
      if (dup) return res.status(400).json({ error: `A template named "${v.name}" already exists` });
      sets.push('name = ?'); vals.push(v.name);
    }

    if (has('config')) {
      // config is the load-bearing part of a template — reject an explicit clear.
      if (body.config == null) return res.status(400).json({ error: 'Template config cannot be empty' });
      sets.push('config = ?');
      vals.push(typeof body.config === 'string' ? body.config : JSON.stringify(body.config));
    }

    if (has('description')) {
      sets.push('description = ?');
      vals.push(typeof body.description === 'string' ? body.description : null);
    }

    if (has('tags')) {
      sets.push('tags = ?');
      vals.push(body.tags == null ? null : (typeof body.tags === 'string' ? body.tags : JSON.stringify(body.tags)));
    }

    if (has('is_draft')) {
      sets.push('is_draft = ?');
      vals.push(body.is_draft ? 1 : 0);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

    sets.push("updated_at = datetime('now')");
    const result = db.prepare(`
      UPDATE http_api_templates SET ${sets.join(', ')} WHERE id = ? AND user_id = ?
    `).run(...vals, id, req.userId!);

    if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
    res.json(db.prepare('SELECT * FROM http_api_templates WHERE id = ?').get(id));
  } catch (error: any) {
    console.error('Update template error:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/templates/:id', authenticateToken, (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const result = db.prepare('DELETE FROM http_api_templates WHERE id = ? AND user_id = ?')
      .run(id, req.userId!);
    if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ message: 'Template deleted successfully' });
  } catch (error: any) {
    console.error('Delete template error:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

router.post('/templates/:id/use', authenticateToken, (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const result = db.prepare(`
      UPDATE http_api_templates SET usage_count = usage_count + 1, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(id, req.userId!);
    if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
    res.json(db.prepare('SELECT * FROM http_api_templates WHERE id = ?').get(id));
  } catch (error: any) {
    console.error('Use template error:', error);
    res.status(500).json({ error: 'Failed to use template' });
  }
});

export default router;
