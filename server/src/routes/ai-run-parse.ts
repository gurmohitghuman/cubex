import { MAX_AI_CONCURRENCY, MAX_OUTPUT_COLUMNS_PER_RUN } from '../lib/constants';
import { sanitizeAndValidateColumnName, findColumnNameCollision } from '../lib/column-names';
import { validateModelParam } from '../lib/ai-model-resolve';
import { OutputColumnSpec, OutputColumnType, SOURCES_KEY } from '../lib/ai-multi-output';

const OUTPUT_COLUMN_TYPES: OutputColumnType[] = ['string', 'number', 'boolean'];

// Validate the optional output_columns spec (structured multi-column output).
// Returns the canonicalized specs, or an error string. Rejects: empty/oversized
// arrays, bad shapes, unknown types, invalid names, and dupes AMONG the specs on
// BOTH the case-insensitive and normalized-token axes (collisions vs EXISTING
// columns + the status column are checked in ai-run-start, where the sheet's
// real columns are known).
function parseOutputColumns(raw: unknown): { specs: OutputColumnSpec[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'output_columns must be a non-empty array.' };
  }
  if (raw.length > MAX_OUTPUT_COLUMNS_PER_RUN) {
    return { error: `output_columns cannot exceed ${MAX_OUTPUT_COLUMNS_PER_RUN} columns.` };
  }
  const seen: string[] = [];
  const specs: OutputColumnSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: 'Each output_columns entry must be an object.' };
    const rawName = (item as { columnName?: unknown }).columnName;
    if (typeof rawName !== 'string') return { error: 'Each output_columns entry needs a string columnName.' };
    const nameCheck = sanitizeAndValidateColumnName(rawName);
    if ('error' in nameCheck) return { error: nameCheck.error };
    if (nameCheck.name.toLowerCase() === SOURCES_KEY) {
      return { error: `"${SOURCES_KEY}" is reserved for the sources list of runs with web search or web fetch. Use another column name.` };
    }
    const type = (item as { type?: unknown }).type;
    if (typeof type !== 'string' || !OUTPUT_COLUMN_TYPES.includes(type as OutputColumnType)) {
      return { error: `output_columns[].type must be one of: ${OUTPUT_COLUMN_TYPES.join(', ')}.` };
    }
    // Shared collision rule, not a lowercase Set: it also catches the
    // normalized-TOKEN axis ("Fit Score" vs "Fit_Score" → both /fit_score),
    // which is what /column prompt references actually resolve on.
    const dup = findColumnNameCollision(nameCheck.name, seen);
    if (dup) {
      return {
        error: `Output column "${nameCheck.name}" collides with "${dup.clash}" — `
          + 'both resolve to the same /column reference. Use distinct names.',
      };
    }
    seen.push(nameCheck.name);
    const description = (item as { description?: unknown }).description;
    specs.push({
      columnName: nameCheck.name,
      type: type as OutputColumnType,
      description: typeof description === 'string' ? description : '',
    });
  }
  return { specs };
}

// Parse + validate + numeric-bound the /ai/run request body. Split out of
// ai-run-start.ts (200-line guardrail), mirroring ai-preview-parse.ts. `model`
// stays OPTIONAL here — resolution against the sheet/account defaults happens
// in the route (it needs DB access); this layer only rejects malformed values.

export interface RunParseError { ok: false; status: number; error: string; }
export interface RunParams {
  ok: true;
  sheetId: string;
  cleanColumnName: string;
  prompt: string;
  systemPrompt: string | undefined;
  model: string | undefined;
  useOpenRouterWebSearch: boolean;
  useWebFetch: boolean;
  safeTemperature: number;
  // undefined = caller didn't specify; the start service resolves the sheet
  // default via resolveAiConcurrency.
  safeConcurrency?: number;
  safeMaxChars: number | null;
  outputColumns?: OutputColumnSpec[];
}

export function parseRunRequest(body: any): RunParams | RunParseError {
  const {
    sheetId, columnName, prompt, systemPrompt,
    model, temperature = 0.7,
    useOpenRouterWebSearch = false,
    useWebFetch = false,
    // NO destructuring default for concurrency: an omitted value must stay
    // undefined so the start service can resolve the sheet's setting. Defaulting
    // it to 5 here is exactly the bug — it made "unspecified" indistinguishable
    // from "the user chose 5".
    maxChars, concurrency,
    outputColumns: rawOutputColumns,
  } = body ?? {};

  if (!sheetId || !columnName || !prompt) {
    return { ok: false, status: 400, error: 'Sheet ID, column name, and prompt are required' };
  }
  if (typeof prompt !== 'string') return { ok: false, status: 400, error: 'Prompt must be a string.' };
  const modelParamError = validateModelParam(model);
  if (modelParamError) return { ok: false, status: 400, error: modelParamError };

  // Structured multi-column output (optional). Combines with web search and web
  // fetch: the run then also fills a "(Data)" citations column
  // (ai-run-start-multi.ts, ai-row-multi.ts).
  let outputColumns: OutputColumnSpec[] | undefined;
  if (rawOutputColumns !== undefined) {
    const parsedCols = parseOutputColumns(rawOutputColumns);
    if ('error' in parsedCols) return { ok: false, status: 400, error: parsedCols.error };
    outputColumns = parsedCols.specs;
  }

  // Canonicalize to the SAME form the cell-PUT / CSV / HTTP write paths use
  // (collapse internal \s+, strip path-unsafe chars), so the derived
  // "(Output)"/"(Data)" columns we create match what later cell writes target
  // (M6). Same shared relaxed validation as /preview. Without this, /run can be
  // called directly with a name containing quotes/control chars — and every
  // subsequent json_set on the derived columns crashes.
  const nameCheck = sanitizeAndValidateColumnName(columnName);
  if ('error' in nameCheck) return { ok: false, status: 400, error: nameCheck.error };

  // Bound numeric body fields. Without this, temperature='hot' goes to OpenRouter
  // unchecked and concurrency=10000 floods our worker.
  const safeTemperature = (typeof temperature === 'number' && Number.isFinite(temperature))
    ? Math.max(0, Math.min(temperature, 2)) : 0.7;
  // undefined (not a number) means "caller didn't choose" — the START service
  // then resolves the sheet's default_ai_concurrency via resolveAiConcurrency.
  // Collapsing that to a literal 5 HERE is what pinned every MCP/API run at 5
  // regardless of the sheet setting, so keep the "unspecified" case distinct.
  // A caller-supplied value is still clamped to [1, MAX_AI_CONCURRENCY].
  const safeConcurrency = (typeof concurrency === 'number' && Number.isFinite(concurrency))
    ? Math.max(1, Math.min(Math.floor(concurrency), MAX_AI_CONCURRENCY)) : undefined;
  const safeMaxChars = (typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0)
    ? Math.min(Math.floor(maxChars), 100000) : null;

  return {
    ok: true,
    sheetId, cleanColumnName: nameCheck.name, prompt, systemPrompt,
    model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
    useOpenRouterWebSearch: !!useOpenRouterWebSearch, useWebFetch: !!useWebFetch,
    safeTemperature, safeConcurrency, safeMaxChars, outputColumns,
  };
}
