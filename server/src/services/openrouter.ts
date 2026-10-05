import OpenAI from 'openai';
import { db } from '../lib/db';
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_ATTRIBUTION_HEADERS,
  AI_REQUEST_TIMEOUT_MS,
} from '../lib/constants';
import { decrypt } from '../lib/crypto';
import { openrouterAgent } from '../lib/openrouter-agent';

// Build an OpenAI-SDK client pointed at OpenRouter, using the stored API key.
// Throws if no key is configured OR the stored key fails to decrypt (which would
// mean the encryption key changed without re-encrypting first).
export async function getOpenRouterClient(userId: string): Promise<OpenAI> {
  const row = db.prepare(
    'SELECT openrouter_api_key_encrypted FROM settings WHERE user_id = ?'
  ).get(userId) as { openrouter_api_key_encrypted: string | null } | undefined;

  let apiKey: string | null = null;
  if (row?.openrouter_api_key_encrypted) {
    apiKey = decrypt(row.openrouter_api_key_encrypted);
    if (apiKey === null) {
      // Decrypt failure — wrong key or tampered blob. Treat as "not
      // configured" rather than crashing the AI run. Log so an operator
      // notices, but don't include the blob itself in the log.
      console.error(`OpenRouter key decrypt failed for user ${userId}; treating as missing.`);
    }
  }

  if (!apiKey) {
    throw new Error('OpenRouter API key not configured');
  }

  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: OPENROUTER_ATTRIBUTION_HEADERS,
    // Shared keep-alive HTTPS agent so AI run rows reuse TCP+TLS sessions
    // instead of paying a fresh ~80ms handshake per row. See openrouter-agent.ts.
    httpAgent: openrouterAgent,
    // COST SAFETY: never auto-retry. The SDK default (maxRetries: 2) retries on
    // timeout/connection errors BEFORE distinguishing them — but with stream:false
    // the provider has already FULLY GENERATED (and billed) by the time a read
    // times out, so a retry RE-GENERATES and double-/triple-charges the user for one
    // intended row. Chat completions are not idempotent, so a retry is never free.
    // A failed row is already user-resumable (placeholder-driven), so we surface the
    // failure instead of silently re-spending. This client is shared by the run
    // worker, preview, and the generate-config/troubleshoot helpers, so this covers
    // every user-key OpenRouter call site.
    // ONE narrow exception, applied by the run-row path only (openrouter-retry.ts):
    // a pre-response stale-keep-alive-socket ECONNRESET is retried once — the
    // request died on the wire, so nothing was generated or billed. Timeouts and
    // everything else stay non-retried per the above.
    maxRetries: 0,
    // Bound a single row's wall-clock (SDK default is 10 min) so a stuck/runaway row
    // can't hold a worker slot — or generate to the token cap — for that long.
    timeout: AI_REQUEST_TIMEOUT_MS,
  });
}
