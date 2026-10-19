// A restore's writes (services/setup-version-restore.ts): inside its
// transaction, the gone columns back, each setup that differs
// (setup-version-write.ts), auto-run off where the version had it off, the
// descriptions and the order; after it, a paid column's auto-run back on
// through the auto-run settings' own checks. An auto-run a person paused stays
// paused at every step. A restore that would make a clean, formula or lookup
// column worked out from itself throws RestoreRefused, rolling the
// transaction back (the plan says so first: setup-version-plan.ts).
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { appendColumnsToOrder } from '../lib/sheet-columns';
import { derivedLoopThrough } from '../lib/derived-loops';
import { writeColumnDescription } from '../lib/column-descriptions';
import { withoutChangeLog } from '../lib/change-log';
import { formulaColumnFor } from '../lib/formula-columns';
import type { Fill, VersionColumn } from '../lib/setup-versions/spec';
import { setDerivedAutorun } from './derived-autorun';
import { saveAutorunSettings } from './autorun-settings';
import type { RestorePlan } from './setup-version-plan';
import {
  writeAiSetup, writeCleanSetup, writeFormulaSetup, writeHttpSetup, writeLookupSetup,
} from './setup-version-write';
import type { RunFail } from './run-shared';

export class RestoreRefused extends Error { constructor(readonly out: RunFail) { super(out.message); } }

// The sheet's auto-runs a person paused: they stay paused (pausedByHand before the writes, pauseAgain after each).
export const pausedByHand = (sheetId: string, userId: string): string[] =>
  db.prepare(`SELECT status_column FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND enabled = 1
    AND paused_reason = 'user'`).pluck().all(sheetId, userId) as string[];

function pauseAgain(sheetId: string, userId: string, columns: string[]): void {
  if (!columns.length) return;
  db.prepare(`UPDATE autorun_columns SET paused_reason = 'user', paused_at = datetime('now'),
      paused_message = 'Resume it to go on; rows added meanwhile run then.'
    WHERE sheet_id = ? AND user_id = ? AND enabled = 1 AND status_column IN (SELECT value FROM json_each(?))`)
    .run(sheetId, userId, JSON.stringify(columns));
}

const derivedInputs = (sheetId: string, userId: string, column: string, f: Fill): string[] =>
  f.kind === 'formula' ? JSON.parse(formulaColumnFor(sheetId, userId, column)?.inputs ?? '[]')
    : f.kind === 'clean' || f.kind === 'lookup' ? [f.source] : [];

function autoRunOff(sheetId: string, userId: string, column: string): void {
  db.prepare(`UPDATE autorun_columns SET enabled = 0, paused_reason = NULL, paused_message = NULL, paused_at = NULL,
    updated_at = datetime('now') WHERE sheet_id = ? AND user_id = ? AND status_column = ?`)
    .run(sheetId, userId, column);
}

// In the restore's transaction. Returns the paid columns whose auto-run goes
// on again (turnAutoRunsOn, after the transaction).
export function writePlan(
  sheetId: string, userId: string, plan: RestorePlan, byName: Map<string, VersionColumn>,
  opts: { hasSecretsScope: boolean; paused: string[] },
): string[] {
  const w = plan.writes;
  appendColumnsToOrder(sheetId, userId, w.addBack);
  const columns = getSheetColumns(sheetId, userId, false);
  for (const [column, f] of w.fills) {
    const on = !!byName.get(column)?.autoRun;
    if (f.kind === 'ai') writeAiSetup(sheetId, userId, column, f);
    else if (f.kind === 'http') writeHttpSetup(sheetId, userId, column, f, columns, opts.hasSecretsScope);
    else if (f.kind === 'clean') writeCleanSetup(sheetId, userId, column, f, on);
    else if (f.kind === 'formula') writeFormulaSetup(sheetId, userId, column, f, on, columns);
    else writeLookupSetup(sheetId, userId, column, f, on);
  }
  const turnOn: string[] = [];
  for (const [column, v] of w.autoRuns) {
    const f = v.fill;
    if (!f || f.kind === 'ai') continue;
    if (f.kind === 'http') {
      if (v.autoRun) turnOn.push(column);
      else autoRunOff(sheetId, userId, column);
    } else if (!w.fills.has(column)) {
      // A written clean, formula or lookup setup set its auto-run already.
      setDerivedAutorun(f.kind, sheetId, userId, column, derivedInputs(sheetId, userId, column, f), !!v.autoRun);
    }
  }
  pauseAgain(sheetId, userId, opts.paused);
  for (const [column, text] of w.descriptions) writeColumnDescription(sheetId, userId, column, text);
  db.prepare(`UPDATE sheets SET column_order = ?, data_version = data_version + 1, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`).run(JSON.stringify(w.order), sheetId, userId);
  for (const [column, f] of w.fills) {
    if (f.kind === 'ai' || f.kind === 'http') continue;
    const loop = derivedLoopThrough(sheetId, userId, column, derivedInputs(sheetId, userId, column, f));
    if (loop) {
      throw new RestoreRefused({ fail: 'conflict', message: `Restoring it would work "${column}" out from itself `
        + `(${loop}). Change one of those columns first.` });
    }
  }
  return turnOn;
}

// The paid columns' auto-run, on with the version's rule and caps. One the
// settings refuse stays off, and its column's note says why.
export async function turnAutoRunsOn(
  sheetId: string, userId: string, columns: string[], byName: Map<string, VersionColumn>,
  opts: { hasSecretsScope: boolean; paused: string[] }, plan: RestorePlan,
): Promise<void> {
  for (const column of columns) {
    const a = byName.get(column)!.autoRun!;
    const out = await withoutChangeLog(() => saveAutorunSettings(userId, sheetId, {
      column, enabled: true, where: a.where, runIf: a.runIf ?? '', dailyCapUsd: a.dailyCapUsd,
      dailyRowCap: a.dailyRowCap,
    }, { hasSecretsScope: opts.hasSecretsScope }));
    if ('ok' in out) {
      if (opts.paused.includes(column)) pauseAgain(sheetId, userId, [column]);
      continue;
    }
    autoRunOff(sheetId, userId, column);
    const said = `Auto-run is off: ${out.message} Turn it on from the column menu.`;
    const p = plan.columns.find(c => c.column === column);
    if (p) p.note = p.note ? `${p.note} ${said}` : said;
    else plan.columns.push({ column, action: 'restore', kind: 'http', fields: [], note: said });
  }
}
