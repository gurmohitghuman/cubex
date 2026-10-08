// What auto-run reads and which rows it fills (pure). Auto-run fills a row once:
// a new row, or one whose inputs just got filled, while its status cell is
// still empty (a ❌ row counts too when an input is written: a fixed input gets
// another try). A row whose cell says it ran (✅, ⏭️) or is running (⏳) is
// left alone, so edits never re-run it and A<->B chains end.
import { PLACEHOLDER } from './placeholder-cells';
import { normalizeColumnName } from './prompt';
import { extractTemplateTokenNames, type HTTPAPIConfig } from './http-request-template';
import { inputTemplates, isEnrichmentConfig, type EnrichCondition } from './enrich-run-config';
import { buildRequest } from './enrich-request';
import { conditionPasses, trimBlank, FAILED_MARK, SKIPPED_MARK } from './enrich-seed';

export type AutorunKind = 'enrichment' | 'http';

const COLUMN_REF = /^\{\{(.+)\}\}$/;

// The sheet columns a request reads. An enrichment's inputs name their column
// exactly ({{Website}}), kept even when the column is gone so auto-run can say
// so. An HTTP request's tokens resolve as the run resolves them (exact, any
// case, or normalized); a token matching no column is a saved key or a URL
// path, not an input.
export function requestColumns(config: HTTPAPIConfig, columns: string[]): string[] {
  const out = new Set<string>();
  if (isEnrichmentConfig(config)) {
    for (const t of Object.values(inputTemplates(config))) {
      const ref = COLUMN_REF.exec(t);
      if (ref) out.add(ref[1]);
    }
    return [...out];
  }
  const rc = config.requestConfig;
  const parts: unknown[] = [rc?.url, rc?.body];
  if (rc?.headers && typeof rc.headers === 'object') {
    for (const [k, v] of Object.entries(rc.headers)) parts.push(k, v);
  }
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    for (const name of extractTemplateTokenNames(part)) {
      const norm = normalizeColumnName(name);
      const col = columns.find(c => c.toLowerCase() === name.toLowerCase() || normalizeColumnName(c) === norm);
      if (col) out.add(col);
    }
  }
  return [...out];
}

// Everything a row change can matter through: the request's columns and the
// "Only run if" columns. markAutorunInputs watches these.
export function watchedColumns(requestCols: string[], where: EnrichCondition[]): string[] {
  return [...new Set([...requestCols, ...where.map(c => c.column)])];
}

export interface CandidatePlan {
  kind: AutorunKind;
  statusColumn: string;
  config: HTTPAPIConfig;
  columns: string[];          // the sheet's column registry
  requestCols: string[];      // HTTP: every one must be filled
  where: EnrichCondition[];
}

// take: run it. done: its status says it ran or is running (forget it).
// waiting: an input is empty or "Only run if" fails (it comes back when one of
// them is written).
export type CandidateVerdict = 'take' | 'done' | 'waiting';

// A cell holding a run's own marker reads as empty: another run is still
// filling it (⏳), or its run found nothing (⏭️) or failed (❌). Those are
// Cubex's words, not data, so they never count as an input (an HTTP column
// must not send "❌ Error" as a lead).
const RUN_MARKERS = [FAILED_MARK, SKIPPED_MARK];
const settled = (data: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    const t = trimBlank(v ?? '');
    out[k] = v === PLACEHOLDER || RUN_MARKERS.some(m => t.startsWith(m)) ? '' : v;
  }
  return out;
};

export function candidateVerdict(
  data: Record<string, string>, p: CandidatePlan, failedCounts: boolean,
): CandidateVerdict {
  const status = trimBlank(data[p.statusColumn] ?? '');
  if (status !== '' && !(failedCounts && status.startsWith(FAILED_MARK))) return 'done';
  const live = settled(data);
  if (!p.where.every(c => conditionPasses(live, c))) return 'waiting';
  if (!isEnrichmentConfig(p.config)) {
    return p.requestCols.every(c => trimBlank(live[c] ?? '') !== '') ? 'take' : 'waiting';
  }
  const e = p.config.enrichment;
  const built = buildRequest(e.toolSnapshot, inputTemplates(p.config), live, {
    cleanDomains: e.cleanDomains, columns: p.columns,
  });
  // A value the tool can't take still runs: its row shows why (❌), as in a run.
  return !built.ok && 'missing' in built ? 'waiting' : 'take';
}

const rowsText = (n: number) => `${n.toLocaleString('en-US')} row${n === 1 ? '' : 's'}`;

// The 409 a sort, row delete, transfer or column change gets while an auto-run
// run is on the sheet (the sheet then yields: lib/sheet-yield.ts).
export function autorunBusyMessage(kind: AutorunKind, column: string, rows: number): string {
  const doing = kind === 'enrichment'
    ? `Auto-run is enriching ${rowsText(rows)} in ${column}.`
    : `Auto-run is running ${column} on ${rowsText(rows)}.`;
  return `${doing} Try again in a moment, or pause auto-run.`;
}
