// A restored column's own setup (services/trash-restore-column.ts): whether it can be set up again now, the
// writes (in the restore's last transaction, as a setup version's restore writes one column:
// setup-version-write.ts), and what the answer says happens next. Nothing runs and nothing is billed:
//   - an AI, HTTP API, enrichment or waterfall column gets a run record that ran nothing (its newest run's
//     settings), so a rerun reads them;
//   - a clean, formula or lookup column gets its record back and works every row out again, as it does once
//     created (a fill, in the background, resumed after a restart).
// Auto-run comes back off for every kind (the answer lists it among the references dropped when it was on).
// A setup that can't work now (its source column gone, a formula reading a column the sheet lost, the other
// sheet of a lookup or a list enrichment gone, a loop) isn't written: the column comes back plain with its
// cells, and says why. A column its AI or HTTP setup wrote that another setup fills now stays with that one
// (trash-restore-column-owners.ts).
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { compileFormula } from '../lib/formula/refs';
import { derivedLoopThrough } from '../lib/derived-loops';
import { httpRunSecretRefsRequiringScope } from '../lib/http-secrets-scan';
import { fillKind, type ColumnKind, type Fill, type VersionColumn } from '../lib/setup-versions/spec';
import type { RefSurface } from '../lib/trash/column-refs-words';
import {
  writeAiSetup, writeCleanSetup, writeFormulaSetup, writeHttpSetup, writeLookupSetup,
} from './setup-version-write';
import { KEYS } from './setup-version-restore';
import { fillProblem } from './setup-version-plan-words';
import { ownedFill, withoutWords, type Taken } from './trash-restore-column-owners';

// taken: the columns it wrote that another setup fills now (it comes back without them).
export interface SetupPlan { kind: ColumnKind; problem: string | null; taken: Taken[] }
export interface SetupWritten { runId: string | null; fill: { table: string; id: string } | null }

const columnsOf = (sheetId: string, userId: string) => getSheetColumns(sheetId, userId, false);
const live = (sheetId: string, userId: string) => !!db.prepare('SELECT 1 FROM sheets WHERE id = ? AND user_id = ? '
  + 'AND trash_id IS NULL').get(sheetId, userId);

function derivedInputs(f: Fill, columns: string[]): string[] {
  if (f.kind === 'formula') return compileFormula(f.formula, columns).inputs;
  return f.kind === 'clean' || f.kind === 'lookup' ? [f.source] : [];
}

// Why its setup can't be written now (null: it can). `columns`: the sheet's, the restored one with them.
function setupProblem(sheetId: string, userId: string, name: string, f: Fill, columns: string[]): string | null {
  if (f.kind === 'ai') return null;
  if (f.kind === 'http') {
    // A list enrichment's sheet gone (its words start a sentence; here they follow a colon).
    const gone = fillProblem(userId, sheetId, f, columns);
    return gone && gone[0].toLowerCase() + gone.slice(1);
  }
  if ((f.kind === 'clean' || f.kind === 'lookup') && !columns.includes(f.source)) {
    return `the column it reads, "${f.source}", is gone`;
  }
  if (f.kind === 'lookup') {
    if (!live(f.otherSheetId, userId)) return 'the sheet it looks in is gone or in the trash';
    const there = columnsOf(f.otherSheetId, userId);
    const missing = [f.matchColumn, ...(f.returnColumns ?? [])].find(c => !there.includes(c));
    if (missing) return `the sheet it looks in has no column "${missing}" now`;
  }
  let inputs: string[];
  try {
    inputs = derivedInputs(f, columns);
  } catch (e) {
    return `its formula no longer reads: ${(e as Error).message}`;
  }
  const loop = derivedLoopThrough(sheetId, userId, name, inputs);
  return loop ? `it would work "${name}" out from itself (${loop})` : null;
}

// What it can write now: without the columns another setup fills now, and why not at all (null: it can).
function shapeOf(sheetId: string, userId: string, name: string, f: Fill, columns: string[]) {
  const owned = ownedFill(sheetId, userId, name, f);
  return { ...owned, problem: owned.problem ?? setupProblem(sheetId, userId, name, owned.fill, columns) };
}

// Before the restore starts: a refusal (its request reads saved keys the caller can't use), or the plan.
export function planColumnSetup(sheetId: string, userId: string, own: VersionColumn, name: string,
  hasSecretsScope: boolean): { refuse: string } | { plan: SetupPlan } {
  const f = own.fill;
  if (!f) return { plan: { kind: 'plain', problem: null, taken: [] } };
  if (f.kind === 'http' && !hasSecretsScope && httpRunSecretRefsRequiringScope(userId,
    { config: JSON.stringify(f.config), allow_secrets: f.allowSecrets }, false).length > 0) {
    return { refuse: `"${own.name}": ${KEYS}` };
  }
  const columns = [...columnsOf(sheetId, userId).filter(c => c !== name), name];
  const { problem, taken } = shapeOf(sheetId, userId, name, f, columns);
  return { plan: { kind: fillKind(f), problem, taken } };
}

// Each kind's record set to work every row out again, as a new one is (its id back).
const fillAgain = (kind: 'clean' | 'formula' | 'lookup') => (kind === 'clean'
  ? db.prepare(`UPDATE clean_columns SET fill_status = 'filling', fill_cursor = 0, filled_rows = 0, blanked_rows = 0,
    error_message = NULL, updated_at = datetime('now') WHERE sheet_id = ? AND user_id = ? AND column_name = ?
    RETURNING id`)
  : kind === 'formula'
    ? db.prepare(`UPDATE formula_columns SET fill_status = 'filling', fill_cursor = 0, filled_rows = 0, error_rows = 0,
      first_error = NULL, error_message = NULL, updated_at = datetime('now')
      WHERE sheet_id = ? AND user_id = ? AND column_name = ? RETURNING id`)
    : db.prepare(`UPDATE lookup_columns SET fill_status = 'filling', fill_cursor = 0, filled_rows = 0, error_rows = 0,
      first_error = NULL, broken = NULL, error_message = NULL, updated_at = datetime('now')
      WHERE sheet_id = ? AND user_id = ? AND column_name = ? RETURNING id`));

// In the restore's last transaction, the column listed under `name`: its setup, auto-run off. A clean,
// formula or lookup record is set to fill again ('filling'), the caller starts the fill after it.
export function writeColumnSetup(sheetId: string, userId: string, own: VersionColumn, name: string,
  plan: SetupPlan, hasSecretsScope: boolean): SetupWritten {
  // Read again: what it reads may have changed since the restore started (another sheet, for a lookup), and
  // so may the setups filling the columns it writes.
  const shape = own.fill ? shapeOf(sheetId, userId, name, own.fill, columnsOf(sheetId, userId)) : null;
  plan.problem = shape?.problem ?? null;
  plan.taken = shape?.taken ?? [];
  const f = shape?.fill;
  if (!f || plan.problem !== null) return { runId: null, fill: null };
  if (f.kind === 'ai') return { runId: writeAiSetup(sheetId, userId, name, f), fill: null };
  if (f.kind === 'http') {
    return { runId: writeHttpSetup(sheetId, userId, name, f, columnsOf(sheetId, userId), hasSecretsScope), fill: null };
  }
  if (f.kind === 'clean') writeCleanSetup(sheetId, userId, name, f, false);
  else if (f.kind === 'formula') writeFormulaSetup(sheetId, userId, name, f, false, columnsOf(sheetId, userId));
  else writeLookupSetup(sheetId, userId, name, f, false);
  const id = fillAgain(f.kind).pluck().get(sheetId, userId, name) as string;
  return { runId: null, fill: { table: `${f.kind}_columns`, id } };
}

const TOOL: Record<'clean' | 'formula' | 'lookup', string> = {
  clean: 'clean_column', formula: 'formula_column', lookup: 'lookup_column',
};

// What happens to its setup, in the words of the surface asking.
export function setupWords(plan: SetupPlan, runId: string | null, s: RefSurface): string {
  const k = plan.kind;
  if (k === 'plain' || k === 'made') return 'It had no setup of its own: it is a plain column again.';
  if (plan.problem) {
    const redo = s === 'app' ? 'Set it up again from its column menu.'
      : k === 'ai' || k === 'http' || k === 'enrichment' || k === 'waterfall' ? 'Set it up again.'
        : `Set it up again with ${TOOL[k]}.`;
    const why = plan.problem.replace(/[.\s]+$/, '');
    return `Its setup wasn't restored: ${why}. It came back as a plain column holding its cells. ${redo}`;
  }
  if (k === 'clean' || k === 'formula' || k === 'lookup') {
    return 'Set up as it was. Its rows are being worked out again now, in the background, as when it was made; '
      + 'auto-run stays off.';
  }
  const type = k === 'ai' ? 'ai' : 'http';
  const rerun = s === 'mcp' ? `control_run with action "rerun", run_type "${k}", run_id `
    + `"${runId}" and a mode ("empty" for the rows it left empty)`
    : s === 'rest' ? `POST /api/v1/${type}-runs/${runId}/rerun with a mode ("empty" for the rows it left empty)`
      : 'Rerun from its column menu';
  const without = plan.taken.length ? `, ${withoutWords(plan.taken)}` : '';
  return `Set up as it was (its newest run's settings)${without}. Nothing ran and auto-run stays off: ${rerun} `
    + 'fills it.';
}
