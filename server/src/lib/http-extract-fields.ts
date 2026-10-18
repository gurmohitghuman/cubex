// The values a response mapping picks from one answer: a JSONPath into the
// body, or @status (HTTP_STATUS_PATH) for the HTTP status code (the response
// code column). Shared by the run (services/http-row.ts) and the preview
// (routes/http-preview.ts), so a preview shows what the run will write.
import { extractOutcome } from './jsonpath-extract';
import { HTTP_STATUS_PATH } from './constants-http-retry';
import type { ResponseMapping } from './http-request-template';

export const isStatusMapping = (m: { jsonPath?: unknown } | null | undefined): boolean =>
  m?.jsonPath === HTTP_STATUS_PATH;

export const statusColumnsOf = (mappings: ResponseMapping[] | undefined): string[] =>
  (Array.isArray(mappings) ? mappings : []).filter(isStatusMapping).map(m => m.columnName);

// A malformed path throws (the row fails with a fixable message) instead of a
// silent empty cell; a path that simply didn't match gives null.
export function extractMappedFields(
  data: unknown, status: number, mappings: ResponseMapping[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of mappings) {
    if (isStatusMapping(m)) { out[m.columnName] = status; continue; }
    const outcome = extractOutcome(data, m.jsonPath);
    if (outcome.error) throw new Error(`JSONPath "${m.jsonPath}" (column "${m.columnName}"): ${outcome.error}`);
    out[m.columnName] = outcome.matched ? outcome.value : null;
  }
  return out;
}

// A failed row still shows the status code when the API answered.
export function failedRowFields(status: number | null, mappings: ResponseMapping[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (status !== null) for (const col of statusColumnsOf(mappings)) out[col] = status;
  return out;
}
