// What a setup version holds (pure): every column the sheet listed, in its
// order, with its description, what fills it and its auto-run. Never a cell.
// A fill is kept as stored, so a restore writes back exactly what was there:
// an AI column's newest run settings, an HTTP API, enrichment or waterfall
// column's newest run config (with the columns it fills), a clean, formula or
// lookup column's record. A column another one fills (an AI column's outputs,
// an HTTP column's picked fields) has no fill of its own.
import type { OutputColumnSpec } from '../ai-multi-output';
import { aiRunDataColumn } from '../ai-data-column';
import type { EnrichCondition } from '../enrich-run-config';
import type { LookupMatch, LookupReturns } from '../lookup-columns';

export interface AiFill {
  kind: 'ai';
  prompt: string; systemPrompt: string | null; model: string | null; temperature: number | null;
  maxChars: number | null; concurrency: number | null; webSearch: boolean; webFetch: boolean;
  outputColumns: OutputColumnSpec[] | null;
  dataColumn: string | null;     // ai_runs.data_column as stored (a structured run's; null for one column)
  searchEngine: string | null; searchMode: string | null; maxSearchesPerRow: number | null;
  searchEngineUsed: string | null; // the engine its runs resolved to (reruns copy it: per-row search caps read it)
  runIf: string | null;
}

export type HttpMode = 'http' | 'enrichment' | 'waterfall';
export interface HttpFill {
  kind: 'http'; mode: HttpMode;
  config: Record<string, any>;   // http_runs.config as stored
  allowSecrets: number;          // http_runs.allow_secrets
  destSheetId: string | null;    // a list enrichment's sheet
  extracted: string[];           // the other columns linked to it (it fills them): what a restore links is
                                 // its config's responseMapping (mappedColumns)
}

export interface CleanFill { kind: 'clean'; source: string; cleaner: string; options: Record<string, unknown> }
export interface FormulaFill { kind: 'formula'; formula: string; description: string | null }
export interface LookupFill {
  kind: 'lookup'; source: string; otherSheetId: string; matchColumn: string; match: LookupMatch;
  returns: LookupReturns; returnColumns: string[] | null; limit: number;
}

export type Fill = AiFill | HttpFill | CleanFill | FormulaFill | LookupFill;

// Auto-run as it was on (null: off). A clean, formula or lookup column's has no rule or cap.
export interface AutoRunSnap {
  where: EnrichCondition[]; runIf: string | null; dailyCapUsd: number | null; dailyRowCap: number | null;
}

export interface VersionColumn {
  name: string; description: string | null; fill: Fill | null; autoRun: AutoRunSnap | null;
}

export interface VersionSpec { v: 1; columns: VersionColumn[] }

// How a column is filled, in words people and agents see.
export type ColumnKind = 'plain' | 'made' | 'ai' | HttpMode | 'clean' | 'formula' | 'lookup';
export const KIND_WORDS: Record<ColumnKind, string> = {
  plain: 'a plain column', made: 'filled by another column', ai: 'an AI column', http: 'an HTTP API column',
  enrichment: 'an enrichment column', waterfall: 'a waterfall column', clean: 'a clean data column',
  formula: 'a formula column', lookup: 'a lookup column',
};

export const fillKind = (f: Fill): Exclude<ColumnKind, 'plain' | 'made'> => (f.kind === 'http' ? f.mode : f.kind);

// The columns a fill writes besides its own column: an AI run's outputs and
// (Data) (by the run's own rule, lib/ai-data-column.ts), an HTTP run's fields.
export function fillMakes(f: Fill, column: string): string[] {
  if (f.kind === 'ai') {
    const data = aiRunDataColumn({ column_name: column, output_columns: f.outputColumns?.length ? 'x' : null,
      data_column: f.dataColumn, use_openrouter_web_search: f.webSearch });
    return [...(f.outputColumns ?? []).map(o => o.columnName), ...(data ? [data] : [])];
  }
  return f.kind === 'http' ? f.extracted : [];
}

// The columns an HTTP run's config writes (its fields, a waterfall's steps).
export const mappedColumns = (config: Record<string, any>): string[] =>
  (Array.isArray(config?.responseMapping) ? config.responseMapping : [])
    .map((m: any) => m?.columnName).filter((c: unknown): c is string => typeof c === 'string');

// Each column's kind, and the column filling the ones another fills.
export function columnKinds(spec: VersionSpec): Map<string, { kind: ColumnKind; by: string | null }> {
  const by = new Map<string, string>();
  for (const c of spec.columns) {
    if (c.fill) for (const m of fillMakes(c.fill, c.name)) if (m !== c.name) by.set(m, c.name);
  }
  const out = new Map<string, { kind: ColumnKind; by: string | null }>();
  for (const c of spec.columns) {
    if (c.fill) out.set(c.name, { kind: fillKind(c.fill), by: null });
    else out.set(c.name, by.has(c.name) ? { kind: 'made', by: by.get(c.name)! } : { kind: 'plain', by: null });
  }
  return out;
}

// A stored spec read back; null when it isn't one (a version saved by a later
// build would say so here rather than restore half of itself).
export function parseVersionSpec(raw: string): VersionSpec | null {
  try {
    const v = JSON.parse(raw) as VersionSpec;
    return v && v.v === 1 && Array.isArray(v.columns) ? v : null;
  } catch {
    return null;
  }
}
