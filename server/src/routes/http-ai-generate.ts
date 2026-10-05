import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveAiModel } from '../lib/ai-model-resolve';
import { getOpenRouterClient } from '../services/openrouter';
import { HTTP_CONFIG_SYSTEM_PROMPT, buildUserMessage } from '../lib/http-config-prompt';
import { hostFromUrl, safeParseJSON, toModalConfig } from '../lib/http-config-shape';
import { getSheetColumns } from '../lib/sql-helpers';

const router = express.Router();

// POST /http/generate-config — AI-driven HTTP enrichment setup.
//
// User describes (in plain English) what they want to look up about each row;
// the model returns a filled-in HTTPAPIConfig shape that the modal can drop
// straight into its existing state and run a preview against. This is the
// "Just tell me what you want" tab.
//
// Why server-side instead of client-side: (1) OpenRouter key lives in the
// settings table on the server, (2) we want to attach the openrouter:web_fetch
// tool with allowed_domains scoped to the docs URL, which is server-side state.
router.post('/generate-config', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const { goal, docsUrl, keyedColumn, sheetId } = req.body as {
      goal?: unknown; docsUrl?: unknown; keyedColumn?: unknown; sheetId?: unknown;
    };
    if (typeof goal !== 'string' || !goal.trim()) {
      return res.status(400).json({ error: 'goal is required' });
    }
    if (typeof sheetId !== 'string' || !sheetId) {
      return res.status(400).json({ error: 'sheetId is required' });
    }
    if (docsUrl !== undefined && typeof docsUrl !== 'string') {
      return res.status(400).json({ error: 'docsUrl must be a string when provided' });
    }
    if (keyedColumn !== undefined && typeof keyedColumn !== 'string') {
      return res.status(400).json({ error: 'keyedColumn must be a string when provided' });
    }

    // Verify sheet ownership AND derive the column list. We feed the column
    // names to the model so it can pick the right /token references.
    const sheet = db.prepare(
      'SELECT id FROM sheets WHERE id = ? AND user_id = ?',
    ).get(sheetId, req.userId!) as { id: string } | undefined;
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    // Strict, same as AI columns: this call bills the user's OpenRouter key, so
    // it only runs on a model they chose — sheet default > account default,
    // NO internal fallback.
    const model = resolveAiModel(undefined, sheetId, req.userId!);
    if (!model) {
      return res.status(400).json({
        error: 'No AI model set. Choose a default model in Settings to use AI-assisted config generation.',
      });
    }

    // getSheetColumns is column_order-first but falls back to an insertion-order
    // scan when column_order is NULL (legacy sheets), so the model always sees
    // the real column list instead of an empty one. Same source of truth as
    // sheets-read / sheets-sort.
    const availableColumns = getSheetColumns(sheetId, req.userId!);

    // Saved credential names — used by the model to wire the right API key
    // header automatically. We only share names, never values.
    const savedKeyNames = (db.prepare(
      'SELECT name FROM api_keys WHERE user_id = ? ORDER BY name ASC',
    ).all(req.userId!) as Array<{ name: string }>).map(r => r.name);

    const trimmedDocsUrl = typeof docsUrl === 'string' ? docsUrl.trim() : '';
    const userMessage = buildUserMessage({
      goal: goal.trim(),
      docsUrl: trimmedDocsUrl || undefined,
      keyedColumn: typeof keyedColumn === 'string' ? keyedColumn.trim() || undefined : undefined,
      availableColumns,
      savedKeyNames,
    });

    // Scope web_fetch to the docs URL's host if provided. Without this scoping
    // the model could fetch anywhere; same threat model as ai-row.ts.
    //
    // ALWAYS send parameters.allowed_domains, even when empty — omitting the key
    // entirely leaves the scope up to OpenRouter's undocumented default, which
    // has historically meant "allow any public URL." A docs URL that doesn't
    // parse to a host (hostFromUrl → null) must therefore block all fetches
    // (empty list), not silently grant unrestricted scope.
    const tools: any[] = [];
    if (trimmedDocsUrl) {
      const allowed = hostFromUrl(trimmedDocsUrl);
      tools.push({
        type: 'openrouter:web_fetch',
        parameters: { allowed_domains: allowed ? [allowed] : [] },
      });
    }

    const openai = await getOpenRouterClient(req.userId!);
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: HTTP_CONFIG_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: 2000,
      ...(tools.length > 0 ? { tools } : {}),
    });

    const raw = completion.choices[0]?.message?.content || '';
    const parsed = safeParseJSON(raw);
    if (!parsed) {
      return res.status(502).json({
        error: 'AI returned a response we could not parse. Try rephrasing the goal or use Manual mode.',
        raw: raw.slice(0, 500),
      });
    }
    if (typeof (parsed as any).error === 'string') {
      return res.status(400).json({ error: (parsed as any).error });
    }
    const config = toModalConfig(parsed);
    if (!config) {
      return res.status(502).json({
        error: 'AI returned an unexpected shape. Try rephrasing the goal or use Manual mode.',
      });
    }
    res.json({ config, notes: typeof (parsed as any).notes === 'string' ? (parsed as any).notes : undefined });
  } catch (error: any) {
    const msg = error?.message || 'Failed to generate config';
    // Surface the no-key case in plain English. Everything else logs and 500s.
    if (msg.includes('OpenRouter API key not configured')) {
      return res.status(400).json({
        error: 'Set your OpenRouter API key in Settings first. AI Generate needs it to read your goal.',
      });
    }
    console.error('http-ai-generate error:', error);
    res.status(500).json({ error: 'Failed to generate config' });
  }
});

export default router;
