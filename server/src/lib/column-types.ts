import { db } from './db';

// AUTHORITATIVE column-type resolution. The grid menu used to GUESS a column's
// type from cell contents (any "✅/❌/⏭️/⏳" → HTTP master) and from its name
// (ends in " (Output)"/" (Data)" → AI). Both misfire: an AI run writes the same
// status emoji into its own cells, so a mid-run AI column read as HTTP and showed
// "HTTP API Actions"; any pasted ✅ or any column literally named "X (Data)" was
// mislabelled too. Derive the type from the run records that actually created the
// column instead — ai_runs / http_runs / http_column_associations.
//
// Returned map holds ONLY non-plain columns; a column absent from the map is
// plain. Callers (and the client) treat absence as 'plain'.

export type ColumnType =
  | 'ai-output'      // AI run target column ("X (Output)")
  | 'ai-data'        // its web-search companion ("X (Data)")
  | 'http-master'    // HTTP run master/status column
  | 'http-extracted' // JSONPath-extracted HTTP response column
  | 'webhook-source' // the read-only "Webhook" marker column (row provenance)
  | 'webhook-mapped'; // a column a webhook mapping writes into

// Resolve every AI/HTTP-owned column on a sheet to its type. A column can match
// more than one source (e.g. a name reused across an old HTTP assoc and a new AI
// run); AI ownership wins last-write so the menu shows AI actions on AI columns —
// the order below encodes that precedence (HTTP first, AI overwrites).
export function getColumnTypes(
  sheetId: string,
  userId: string,
): Record<string, ColumnType> {
  const types: Record<string, ColumnType> = {};

  // HTTP master columns: from live/past runs AND from associations (an
  // association can outlive its run record after a rerun swaps run_id).
  const httpMasters = db.prepare(
    `SELECT DISTINCT master_column_name AS name FROM http_runs
       WHERE sheet_id = ? AND user_id = ? AND master_column_name IS NOT NULL
     UNION
     SELECT DISTINCT master_column_name AS name FROM http_column_associations
       WHERE sheet_id = ? AND user_id = ? AND master_column_name IS NOT NULL`,
  ).all(sheetId, userId, sheetId, userId) as Array<{ name: string }>;
  for (const { name } of httpMasters) types[name] = 'http-master';

  // HTTP extracted columns (response-mapping outputs).
  const httpExtracted = db.prepare(
    `SELECT DISTINCT extracted_column_name AS name FROM http_column_associations
       WHERE sheet_id = ? AND user_id = ? AND extracted_column_name IS NOT NULL`,
  ).all(sheetId, userId) as Array<{ name: string }>;
  for (const { name } of httpExtracted) {
    // Don't downgrade a master that also appears as an extracted name.
    if (types[name] !== 'http-master') types[name] = 'http-extracted';
  }

  // AI columns: ai_runs.column_name is the "(Output)" column (single-column) or
  // the status column (structured runs); output_columns lists a structured run's
  // N typed columns. The "(Data)" companion exists only for web-search runs
  // (mutually exclusive with output_columns). AI wins over any HTTP match.
  const aiRuns = db.prepare(
    `SELECT column_name AS name, use_openrouter_web_search AS web, output_columns AS outputCols FROM ai_runs
       WHERE sheet_id = ? AND user_id = ?`,
  ).all(sheetId, userId) as Array<{ name: string; web: number; outputCols: string | null }>;
  for (const { name, web, outputCols } of aiRuns) {
    types[name] = 'ai-output';
    if (outputCols) {
      try {
        for (const s of JSON.parse(outputCols) as Array<{ columnName?: unknown }>) {
          if (s && typeof s.columnName === 'string') types[s.columnName] = 'ai-output';
        }
      } catch { /* malformed spec — status column still classified */ }
    } else if (web) {
      const dataCol = name.endsWith(' (Output)')
        ? name.replace(/ \(Output\)$/, ' (Data)')
        : `${name} (Data)`;
      types[dataCol] = 'ai-data';
    }
  }

  // Webhook columns: the raw marker column (webhook_sources.raw_column_name) is
  // read-only row-provenance; mapped columns (webhook_mappings.column_name) are
  // where webhook deliveries write. Derived from the records that created them,
  // same as AI/HTTP — never guessed from cell contents.
  const whSources = db.prepare(
    `SELECT raw_column_name AS name FROM webhook_sources WHERE sheet_id = ? AND user_id = ?`,
  ).all(sheetId, userId) as Array<{ name: string }>;
  for (const { name } of whSources) types[name] = 'webhook-source';

  const whMapped = db.prepare(
    `SELECT m.column_name AS name FROM webhook_mappings m
       JOIN webhook_sources s ON s.id = m.source_id
       WHERE s.sheet_id = ? AND s.user_id = ?`,
  ).all(sheetId, userId) as Array<{ name: string }>;
  for (const { name } of whMapped) {
    // Don't downgrade the raw marker if a mapping somehow reused its name.
    if (types[name] !== 'webhook-source') types[name] = 'webhook-mapped';
  }

  return types;
}
