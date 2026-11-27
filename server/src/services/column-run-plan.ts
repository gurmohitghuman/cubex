// What a column run would do on a sheet (services/column-run.ts), checked
// before anything is priced or started: each chosen column resolved to the
// run that fills it (any of a run's columns names it; two of one run are one
// step), the order they go in (lib/column-runs/order.ts: a column waits for the
// chosen columns it reads, also through clean, formula and lookup columns), a
// `where` checked as read_rows checks it and refused when it reads a column the
// run changes, row_ids that are all in the sheet, and no live setup or column
// run already filling one of these columns. A pure read.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { sheetColumnKinds } from '../lib/column-types';
import { derivedGraph } from '../lib/derived-loops';
import { ruleColumns } from '../lib/run-condition';
import { orderColumns, type OrderColumn } from '../lib/column-runs/order';
import { activeWhere, whereConditions } from '../lib/row-filter/where';
import { isStateOp } from '../lib/row-filter/ops';
import { stepColumns } from '../lib/setups/spec';
import { httpRunSecretRefsRequiringScope } from '../lib/http-secrets-scan';
import { columnRunInputs } from './column-run-inputs';
import { liveRunColumns, prepareWhere } from './row-filter';
import { runColumnOf, type RunKind } from './run-controls-column';
import { planOf, type SetupRunRow } from './setup-run-store';
import type { ColumnRunInput } from './column-run-input';
import type { RunFail } from './run-shared';

export interface PlannedColumn {
  column: string;    // the run's main column
  kind: RunKind;
  layer: number;
  waitsFor: number[]; // the chosen columns (indexes) it waits for
  between: string[];  // clean, formula and lookup columns it reads its earlier columns through
  ruleReads: string[]; // the columns its "Only run if" reads
}
export interface ColumnRunPlanned { columns: PlannedColumn[]; changes: string[] }

const quoted = (names: string[]) => names.map(n => `"${n}"`).join(', ');
const NOT_RUN: Partial<Record<string, string>> = {
  clean: 'a clean data column', formula: 'a formula column', lookup: 'a lookup column',
};

// The columns a run column's "Only run if" reads (an enrichment's older list of conditions too).
function ruleReads(sheetId: string, userId: string, kind: RunKind, main: string): string[] {
  if (kind === 'ai') {
    const rule = db.prepare(`SELECT run_if FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND column_name = ?
      ORDER BY rowid DESC LIMIT 1`).pluck().get(sheetId, userId, main) as string | null | undefined;
    return rule ? ruleColumns(rule) : [];
  }
  const raw = db.prepare(`SELECT config FROM http_runs WHERE rowid = (SELECT MAX(rowid) FROM http_runs
    WHERE sheet_id = ? AND master_column_name = ?) AND user_id = ?`).pluck().get(sheetId, main, userId) as
    string | null | undefined;
  try {
    const config = raw ? JSON.parse(raw) as { runIf?: string; enrichment?: { rows?: { where?: unknown } } } : null;
    const where = config?.enrichment?.rows?.where;
    const conditions = Array.isArray(where)
      ? where.flatMap(c => (c && typeof c.column === 'string' ? [c.column as string] : [])) : [];
    return [...(config?.runIf ? ruleColumns(config.runIf) : []), ...conditions];
  } catch { return []; }
}

// The saved keys a run column's newest run reads that a caller without 'secrets' may not use (an AI column
// reads none). The same check as a rerun's (services/run-rerun-by-id.ts): a run kept from saved keys reads none.
export function columnSavedKeys(userId: string, sheetId: string, kind: RunKind, main: string): string[] {
  if (kind === 'ai') return [];
  const latest = db.prepare(`SELECT config, allow_secrets FROM http_runs WHERE sheet_id = ? AND user_id = ?
    AND master_column_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sheetId, userId, main) as
    { config: string | null; allow_secrets: number } | undefined;
  return latest ? httpRunSecretRefsRequiringScope(userId, latest, false) : [];
}

// The columns live setup and column runs of the sheet fill, lowercased.
function liveColumns(sheetId: string, userId: string): Set<string> {
  const live = db.prepare(`SELECT * FROM setup_runs WHERE sheet_id = ? AND user_id = ?
    AND status IN ('running', 'paused')`).all(sheetId, userId) as SetupRunRow[];
  return new Set(live.flatMap(r => {
    const plan = planOf(r);
    return plan.columns ? plan.columns.steps.flatMap(s => s.writes) : plan.spec.steps.flatMap(stepColumns);
  }).map(c => c.toLowerCase()));
}

// A live setup or column run already filling one of these columns: refused, or null. Asked again right before
// a start's record is written (column-run.ts), since the start waits on its where and estimate after planning.
export function liveColumnClash(sheetId: string, userId: string, mains: string[]): RunFail | null {
  const busy = liveColumns(sheetId, userId);
  const clash = mains.filter(c => busy.has(c.toLowerCase()));
  if (!clash.length) return null;
  return { fail: 'conflict', message: `A setup or column run working on this sheet fills ${quoted(clash)}. `
    + 'Wait for it to end (get_run (action setup)), or stop it, then run these columns.' };
}

export function planColumnRun(
  userId: string, sheetId: string, input: Pick<ColumnRunInput, 'columns' | 'rowIds' | 'where'>,
  caller: { hasSecretsScope: boolean },
): { ok: ColumnRunPlanned & { writes: string[][] } } | RunFail {
  const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
  const columns = getSheetColumns(sheetId, userId, false);
  const kinds = sheetColumnKinds(sheetId, userId);
  const live = liveRunColumns(kinds.runState, columns);

  const chosen: Array<OrderColumn & { kind: RunKind; rule: string[] }> = [];
  for (const name of input.columns) {
    const run = runColumnOf(sheetId, userId, name);
    if (!run) {
      if (!columns.includes(name)) return { fail: 'not_found', message: `This sheet has no column "${name}".` };
      const what = NOT_RUN[kinds.types[name] ?? ''];
      return bad(what
        ? `"${name}" is ${what}: it follows its columns for free, so it isn't run. Choose the columns it reads.`
        : `"${name}" isn't filled by a run. Choose AI, HTTP API, enrichment or waterfall columns.`);
    }
    if (chosen.some(c => c.main === run.main)) continue;
    const keys = caller.hasSecretsScope ? [] : columnSavedKeys(userId, sheetId, run.kind, run.main);
    if (keys.length) {
      return { fail: 'forbidden', message: `"${run.main}" reads saved keys (${keys.join(', ')}). The access `
        + 'token needs the \'secrets\' scope to run it.' };
    }
    const writes = [run.main, ...columns.filter(c => c !== run.main && live.get(c) === run.main)];
    const inputs = (columnRunInputs(sheetId, userId, run.main, columns) ?? []).filter((c): c is string => c !== null);
    const rule = ruleReads(sheetId, userId, run.kind, run.main);
    chosen.push({ main: run.main, kind: run.kind, writes, reads: [...new Set([...inputs, ...rule])], rule });
  }

  const order = orderColumns(chosen, derivedGraph(sheetId, userId));
  if ('problem' in order) return bad(order.problem);
  const { layers, waitsFor, between, changes } = order.ok;

  if (input.where) {
    const prepared = prepareWhere(sheetId, userId, input.where, columns);
    if ('error' in prepared) return bad(prepared.error);
    const conditions = whereConditions(activeWhere(input.where));
    const reads = new Set(conditions.flatMap(c => (c.column !== undefined ? [c.column]
      : isStateOp(c.operator) ? [...prepared.ok.runColumns.keys()] : [])));
    const changed = changes.filter(c => reads.has(c));
    if (changed.length) {
      return bad(`The where reads ${quoted(changed)}, which this run changes, so the rows it picks would move `
        + 'while it goes. Filter on columns the run leaves alone.');
    }
  }
  if (input.rowIds) {
    const found = db.prepare(`SELECT id FROM rows WHERE sheet_id = ? AND user_id = ?
      AND id IN (SELECT value FROM json_each(?))`).pluck().all(sheetId, userId, JSON.stringify(input.rowIds)) as
      string[];
    if (found.length < input.rowIds.length) {
      const have = new Set(found);
      const gone = input.rowIds.filter(id => !have.has(id));
      return { fail: 'not_found', message: `${gone.length} of the row_ids aren't rows of this sheet `
        + `(${gone.slice(0, 3).join(', ')}${gone.length > 3 ? ', …' : ''}). read_rows gives each row's id.` };
    }
  }
  const clash = liveColumnClash(sheetId, userId, chosen.map(c => c.main));
  if (clash) return clash;
  // In the order they run: by layer, then as asked.
  const byLayer = chosen.map((_, i) => i).sort((a, b) => layers[a] - layers[b] || a - b);
  const at = new Map(byLayer.map((i, k) => [i, k]));
  return {
    ok: {
      columns: byLayer.map(i => ({
        column: chosen[i].main, kind: chosen[i].kind, layer: layers[i], waitsFor: waitsFor[i].map(j => at.get(j)!),
        between: between[i], ruleReads: chosen[i].rule,
      })),
      writes: byLayer.map(i => chosen[i].writes), changes,
    },
  };
}
