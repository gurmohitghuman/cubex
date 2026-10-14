// What auto-run reads and which rows it fills (pure). Auto-run fills a row once:
// a new row, or one whose inputs just got filled, while its status cell is
// still empty (a ❌ row counts too when an input is written: a fixed input gets
// another try). A row whose cell says it ran (✅, ⏭️) or is running (⏳) is
// left alone, so edits never re-run it and A<->B chains end.
import { goneColumnsOf, templateTokenIs } from './template-token-match';
import { extractTemplateTokenNames, TEMPLATE_TOKEN_RE, type HTTPAPIConfig } from './http-request-template';
import { inputTemplates, isEnrichmentConfig, type EnrichCondition } from './enrich-run-config';
import { buildRequest } from './enrich-request';
import { passesRunConditions, holdsRunMarker, trimBlank, FAILED_MARK } from './enrich-seed';
import { isConditionNotMet } from './run-markers';
import { ruleColumns, type RuleNode } from './run-condition';

export type AutorunKind = 'enrichment' | 'http' | 'clean' | 'formula';

const COLUMN_REF = /^\{\{(.+)\}\}$/;

// The parts of an HTTP request that hold template tokens.
function requestParts(config: HTTPAPIConfig): string[] {
  const rc = config.requestConfig;
  const parts: unknown[] = [rc?.url, rc?.body];
  if (rc?.headers && typeof rc.headers === 'object') {
    for (const [k, v] of Object.entries(rc.headers)) parts.push(k, v);
  }
  return parts.filter((p): p is string => typeof p === 'string');
}

// The column a token names, as the run resolves it (exact, any case, or normalized).
const columnFor = (name: string, columns: string[]): string | undefined =>
  columns.find(c => templateTokenIs(name, c));

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
  for (const part of requestParts(config)) {
    for (const name of extractTemplateTokenNames(part)) {
      const col = columnFor(name, columns);
      if (col) out.add(col);
    }
  }
  return [...out];
}

// What a request reads that isn't there, or null. Turning auto-run on and its
// tick (services/autorun-loop.ts) ask the same. `before`: the columns the
// auto-run watched until now, and the ones its request read that were deleted
// (lib/template-token-match.ts). One of those gone is gone, even when a saved key
// has its name: the run never sends that key in its place, it refuses the row.
// Then an HTTP request's {{name}} must name a column or a saved key the run may
// use (`keys`): the run refuses every row on one that names neither.
export function missingRequestRead(
  config: HTTPAPIConfig, columns: string[], before: string[], keys: Set<string>,
): string | null {
  const was = [...before, ...goneColumnsOf(config.requestConfig)];
  const gone = requestColumns(config, [...columns, ...was]).find(c => !columns.includes(c));
  if (gone || isEnrichmentConfig(config)) return gone ?? null;
  for (const part of requestParts(config)) {
    for (const m of part.matchAll(TEMPLATE_TOKEN_RE)) {
      const name = m[1]?.trim();
      if (name && !columnFor(name, columns) && !keys.has(name)) return name;
    }
  }
  return null;
}

// Everything a row change can matter through: the request's columns and the
// "Only run if" columns (the condition list's and the rule's). markAutorunInputs
// watches these.
export function watchedColumns(requestCols: string[], where: EnrichCondition[], rule: string | null = null): string[] {
  return [...new Set([...requestCols, ...where.map(c => c.column), ...(rule ? ruleColumns(rule) : [])])];
}

export interface CandidatePlan {
  kind: AutorunKind;
  statusColumn: string;
  config: HTTPAPIConfig;
  columns: string[];          // the sheet's column registry
  requestCols: string[];      // HTTP: every one must be filled
  where: EnrichCondition[];
  rule: RuleNode | null;      // auto-run's "Only run if" rule
}

// take: run it. done: its status says it ran or is running (forget it).
// waiting: an input is empty or "Only run if" fails (it comes back when one of
// them is written).
export type CandidateVerdict = 'take' | 'done' | 'waiting';

// A cell holding a run's own marker reads as empty: another run is still
// filling it (⏳), its run found nothing (⏭️) or failed (❌), or its rows are
// being added elsewhere (➕). Those are Cubex's words, not data, so they never
// count as an input (an HTTP column must not send "❌ Error" as a lead).
const settled = (data: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) out[k] = holdsRunMarker(v ?? '') ? '' : v;
  return out;
};

export function candidateVerdict(
  data: Record<string, string>, p: CandidatePlan, failedCounts: boolean,
): CandidateVerdict {
  const status = trimBlank(data[p.statusColumn] ?? '');
  // A row an "Only run if" kept out of a run wasn't run: it goes on waiting.
  if (status !== '' && !isConditionNotMet(status) && !(failedCounts && status.startsWith(FAILED_MARK))) return 'done';
  const live = settled(data);
  if (!passesRunConditions(live, p.where, p.rule)) return 'waiting';
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
