import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveAiModel } from '../lib/ai-model-resolve';
import { getOpenRouterClient } from '../services/openrouter';
import { redactSecrets } from '../lib/http-request';
import { safeParseJSON, toModalConfig } from '../lib/http-config-shape';

const router = express.Router();

// POST /http/troubleshoot-config — "AI fix this" given a failed preview.
//
// User has already auto-filled and tried; the preview returned errors. We
// send the model the original goal, the request shape it built, and the
// upstream error response(s). The model proposes a corrected HTTPAPIConfig
// — typically fixing wrong header name, wrong endpoint path, missing query
// param, etc.
//
// Sensitive values (Bearer tokens, API keys, headers like Authorization) are
// REDACTED before being sent to the model — the model only needs to know the
// shape, not the secret. The user's saved-key references (`/keyName`) are
// kept as-is since they're not secrets themselves.
router.post('/troubleshoot-config', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const { goal, sheetId, currentConfig, errorSamples } = req.body as {
      goal?: unknown; sheetId?: unknown; currentConfig?: unknown; errorSamples?: unknown;
    };
    if (typeof sheetId !== 'string' || !sheetId) {
      return res.status(400).json({ error: 'sheetId is required' });
    }
    if (!currentConfig || typeof currentConfig !== 'object') {
      return res.status(400).json({ error: 'currentConfig is required' });
    }
    if (!Array.isArray(errorSamples) || errorSamples.length === 0) {
      return res.status(400).json({ error: 'errorSamples is required' });
    }

    const sheet = db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?')
      .get(sheetId, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    // Strict, same as AI columns / generate-config: bills the user's key, so it
    // only runs on a chosen model (sheet default > account default, no fallback).
    const model = resolveAiModel(undefined, sheetId, req.userId!);
    if (!model) {
      return res.status(400).json({
        error: 'No AI model set. Choose a default model in Settings to use AI-assisted config generation.',
      });
    }

    const redacted = redactConfig(currentConfig as any);
    // Don't trust the client to have redacted. Upstream error bodies can echo the
    // user's own API key (Bearer/sk-* tokens); strip them server-side BEFORE
    // truncating so a secret straddling the 800-char boundary is still caught.
    // Pattern-based defense-in-depth — catches sk-*/Bearer, not every key shape.
    const samplesText = (errorSamples as any[])
      .slice(0, 3)
      .map((s, i) => `Sample ${i + 1}: ${truncate(redactSecrets(typeof s === 'string' ? s : JSON.stringify(s)), 800)}`)
      .join('\n\n');

    const userMessage = JSON.stringify({
      goal: typeof goal === 'string' ? goal : '(not provided)',
      currentConfig: redacted,
      errorSamples: samplesText,
    }, null, 2);

    const openai = await getOpenRouterClient(req.userId!);
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: TROUBLESHOOT_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: 1500,
    });

    const raw = completion.choices[0]?.message?.content || '';
    const parsed = safeParseJSON(raw);
    if (!parsed) {
      return res.status(502).json({
        error: 'AI returned an unparseable response. Try editing the config manually.',
        raw: raw.slice(0, 500),
      });
    }
    if (typeof (parsed as any).explanation !== 'string') {
      return res.status(502).json({ error: 'AI did not explain its fix.' });
    }
    const config = toModalConfig(parsed);
    if (!config) {
      return res.status(502).json({ error: 'AI returned an unexpected config shape.' });
    }
    res.json({ config, explanation: (parsed as any).explanation });
  } catch (error: any) {
    const msg = error?.message || 'Failed to troubleshoot';
    if (msg.includes('OpenRouter API key not configured')) {
      return res.status(400).json({ error: 'Set your OpenRouter API key in Settings first.' });
    }
    console.error('http-ai-troubleshoot error:', error);
    res.status(500).json({ error: 'Failed to troubleshoot' });
  }
});

const TROUBLESHOOT_SYSTEM_PROMPT = `You debug HTTP API configurations for a no-code spreadsheet enrichment tool.

The user previously auto-generated a request config, ran it on a sample row, and got an error. Your job: read the request shape and the upstream error, propose a corrected config, and explain what you changed in one sentence.

Common fixes you should consider:
- Wrong header name (e.g. provider wants X-API-Key, not Authorization).
- Wrong endpoint path (e.g. /v1/users instead of /api/users, or vice versa).
- Missing required query param visible in the error message.
- Wrong HTTP method (e.g. needs POST with a body, not GET).
- Extra path segments from a docs viewer URL leaking into the endpoint.

If the upstream error is purely an authentication failure (401/403) and the header shape looks correct, the user's API key is probably wrong/expired — say so in the explanation and DO NOT change the config in a way that hides the real cause.

Output ONLY a strict JSON object with this exact shape (no markdown):
{
  "method": "GET" | "POST" | "PUT" | "DELETE",
  "endpointUrl": string,
  "queryParams": [{ "key": string, "value": string }],
  "headers": [{ "key": string, "value": string }],
  "body": string,
  "responseMapping": [{ "jsonPath": string, "columnName": string }],
  "explanation": string  // ONE plain-English sentence on what you changed and why
}

Preserve user-supplied values unless changing them is the fix:
- Keep /columnName and /apiKeyName tokens — these are runtime substitutions, NOT broken values.
- Keep responseMapping entries the user already added.
- Only edit fields you're changing as part of the fix.`;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '… (truncated)';
}

// Replace any header value that looks like a real secret with a marker before
// sending the config to the model. The model doesn't need the actual key —
// it just needs to know "there's an Authorization: Bearer header here." Saved-
// key references (`/keyName`) are NOT secrets and are preserved.
function redactConfig(config: any): any {
  if (!config || typeof config !== 'object') return config;
  const headers = Array.isArray(config.headers)
    ? config.headers.map((h: any) => {
        if (!h || typeof h.value !== 'string') return h;
        const v = h.value;
        // Saved-key reference (`/name`) — not a secret, preserve.
        if (/^\/[a-zA-Z0-9_]+$/.test(v) || /^Bearer\s+\/[a-zA-Z0-9_]+$/.test(v)) return h;
        // Bearer with anything else → redact the token portion.
        if (/^Bearer\s+/.test(v)) return { ...h, value: 'Bearer [REDACTED]' };
        // Any header named like an API key → redact the value.
        if (/api[-_ ]?key|token|secret/i.test(h.key) && v.length > 0) {
          return { ...h, value: '[REDACTED]' };
        }
        return h;
      })
    : [];
  return { ...config, headers };
}

export default router;
