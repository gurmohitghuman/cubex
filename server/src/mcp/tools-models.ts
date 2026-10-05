// AI-model tools: discovery (list_models — without it agents must guess
// OpenRouter ids) and default management (set_default_model — account-wide or
// per-sheet; per-run picks stay the `model` arg on run_ai_column). Model
// resolution order and the no-hardcoded-fallback invariant live in
// lib/ai-model-resolve.ts.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchModels, TrimmedModel } from '../lib/openrouter';
import { searchModels } from '../lib/model-search';
import { getAccountDefaultModel } from '../lib/ai-model-resolve';
import { setAccountDefaultModel, setSheetDefaultModel } from '../services/ai-model-config';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

// The full OpenRouter list is 300+ models; dumping it into an agent's context
// is exactly the bloat the tool design avoids — hence the filter + page cap.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// For BROWSING, stale cache beats nothing: fresh, else stale, else null.
async function browseModels(): Promise<TrimmedModel[] | null> {
  const result = await fetchModels(Date.now());
  if (result.ok) return result.models;
  return result.stale ?? null;
}

// For VALIDATION, only a FRESH catalog may reject: a stale list
// wouldn't contain a valid, newly-added OpenRouter id, so rejecting against
// it during an outage would block a legitimate set. Null = don't validate.
async function freshModels(): Promise<TrimmedModel[] | null> {
  const result = await fetchModels(Date.now());
  return result.ok ? result.models : null;
}

export function registerModelTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'list_models',
    {
      description:
        'List AI models available for run_ai_column (OpenRouter catalog: id, name, context length, per-token pricing). Use search to narrow (e.g. "claude", "gpt-4o", "gemini") — the full catalog is 300+ models. Also returns the account\'s default model (used when a run specifies none).',
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive substring match on model id/name'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max results, default ${DEFAULT_LIMIT}`),
      },
    },
    async ({ search, limit }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      const models = await browseModels();
      if (!models) return err('Could not fetch the model list from OpenRouter. Try again shortly.');
      return ok({
        ...searchModels(models, search, limit ?? DEFAULT_LIMIT),
        account_default_model: getAccountDefaultModel(ctx.userId),
      });
    },
  );

  registerTool(server, 
    'set_default_model',
    {
      description:
        'Set (or clear with null) the default AI model. Without sheet_id it sets the ACCOUNT default; with sheet_id it sets that sheet\'s default, which overrides the account one. run_ai_column uses these when no model is passed. Clearing both means AI runs require an explicit model.',
      inputSchema: {
        model: z.string().nullable().describe('OpenRouter model id from list_models; null clears the default'),
        sheet_id: z.string().optional().describe('Omit for the account-wide default'),
      },
    },
    async ({ model, sheet_id }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      // Catch typos while a FRESH catalog is reachable: a bad DEFAULT is
      // sticky — every later run fails confusingly. Catalog unavailable →
      // accept, but say so (validated: false), so the agent isn't misled
      // into thinking the id was checked.
      let validated = true;
      if (typeof model === 'string' && model.trim()) {
        const models = await freshModels();
        if (!models) validated = false;
        else if (!models.some(m => m.id === model.trim())) {
          return err(`Unknown model id "${model.trim()}". Use list_models (with search) to find the exact id.`);
        }
      }
      const result = sheet_id
        ? setSheetDefaultModel(ctx.userId, sheet_id, model)
        : setAccountDefaultModel(ctx.userId, model);
      if ('fail' in result) return err(result.message);
      return ok({
        ...(sheet_id
          ? { sheet_id, default_ai_model: result.ok.model }
          : { account_default_model: result.ok.model }),
        ...(validated ? {} : {
          validated: false,
          warning: 'OpenRouter catalog unreachable; the id was saved without validation.',
        }),
      });
    },
  );
}
