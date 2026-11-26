// Over 200 lines: the apply's one transaction and the words for what it did, read together.
// Applying a test (migration 070): the copy's setup becomes the sheet's, as a setup version's restore writes one
// (setup-version-plan.ts and -apply.ts): the sheet's setup is kept first as a version ("Before applying a test"),
// columns added in the test are added (empty), columns set up differently there take the test's setup, and the
// order follows the copy. A column the test deleted stays, as a restore leaves it. Auto-run stays as the sheet has
// it (a test turns none on or off). The sample rows' results go back (sheet-test-results.ts), and the changed
// clean, formula and lookup columns are worked out again on every row (free). Nothing paid runs on the other
// rows. Refused while a run or a fill is going on the copy. A dry run does it all in a transaction it rolls back,
// so it answers exactly what applying would do.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { continueInBackground, sheetBusyWith, withSheetBusy } from '../lib/sheet-busy';
import { releaseTestHold } from '../lib/sheet-test-hold';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { httpRunSecretRefsRequiringScope } from '../lib/http-secrets-scan';
import { countOf, logSheetChange } from '../lib/change-log';
import type { Fill, VersionSpec } from '../lib/setup-versions/spec';
import { snapshotSheet } from './setup-version-snapshot';
import { fieldContext, planRestore, type PlannedColumn, type RestorePlan } from './setup-version-plan';
import { pausedByHand, RestoreRefused, turnAutoRunsOn, writePlan } from './setup-version-apply';
import { insertVersion, type VersionInfo } from './setup-version-store';
import { runDerivedFill } from './derived-fill';
import { cleanKind } from './clean-kind';
import { formulaKind } from './formula-kind';
import { lookupKind } from './lookup-kind';
import { sheetWorkGoing } from './sheet-work-going';
import { keepTestResults } from './sheet-test-results';
import { finishEnding, markEnding } from './sheet-test-end';
import { testOfSheet, testView, type TestRecord, type TestView } from './sheet-test-store';
import type { RunFail } from './run-shared';

export interface ApplyAnswer {
  test: TestView; dry_run: boolean; nothing: boolean; blocked: string | null;
  columns: PlannedColumn[];               // added (add_back), set up as in the test (restore), left as they are
  results_kept: Record<string, number>;   // sample rows whose result goes back, by column
  worked_out_again: string[];             // clean, formula and lookup columns filled again (free)
  not_in_test: string[];                  // the sheet's columns the copy doesn't have: they stay
  saved_before: VersionInfo | null; message: string;
}

const conflict = (message: string): RunFail => ({ fail: 'conflict', message });
const DERIVED = { clean: cleanKind, formula: formulaKind, lookup: lookupKind } as const;
type DerivedName = keyof typeof DERIVED;
const isPaid = (f: Fill | null) => !!f && (f.kind === 'ai' || f.kind === 'http');

// The copy's setup, with auto-run as the sheet has it (a column new in the test: a paid one off, a free one as set).
function testSpec(t: TestRecord, live: VersionSpec): VersionSpec {
  const auto = new Map(live.columns.map(c => [c.name, c.autoRun]));
  const copy = snapshotSheet(t.test_sheet_id, t.user_id);
  return { ...copy, columns: copy.columns.map(c => ({ ...c,
    autoRun: auto.has(c.name) ? auto.get(c.name)! : isPaid(c.fill) ? null : c.autoRun })) };
}

function problem(t: TestRecord, plan: RestorePlan, hasSecretsScope: boolean): RunFail | null {
  if (plan.loop) return conflict(plan.loop);
  if (getSheetColumns(t.sheet_id, t.user_id, false).length + plan.writes.addBack.length > MAX_COLUMNS_PER_SHEET) {
    return { fail: 'cap', message: `Adding ${plan.writes.addBack.length} columns would pass the column limit `
      + `(${MAX_COLUMNS_PER_SHEET} per sheet). Delete unused columns first.` };
  }
  if (hasSecretsScope) return null;
  for (const [column, f] of plan.writes.fills) {
    if (f.kind !== 'http') continue;
    const refs = httpRunSecretRefsRequiringScope(t.user_id,
      { config: JSON.stringify(f.config), allow_secrets: f.allowSecrets }, false);
    if (refs.length) return { fail: 'forbidden', message: `"${column}": its request reads saved API keys, so `
      + 'applying it needs the \'secrets\' scope.' };
  }
  return null;
}

// Changed clean, formula and lookup columns: filling again (in the transaction); their records, to run after.
function refill(t: TestRecord, fills: Map<string, Fill>): Array<[DerivedName, string, string]> {
  const out: Array<[DerivedName, string, string]> = [];
  for (const [column, f] of fills) {
    if (f.kind !== 'clean' && f.kind !== 'formula' && f.kind !== 'lookup') continue;
    const id = db.prepare(`UPDATE ${DERIVED[f.kind].table} SET fill_status = 'filling', fill_cursor = 0,
        filled_rows = 0, error_message = NULL, updated_at = datetime('now')
      WHERE sheet_id = ? AND user_id = ? AND column_name = ? RETURNING id`).pluck()
      .get(t.sheet_id, t.user_id, column) as string | undefined;
    if (id) out.push([f.kind, id, column]);
  }
  return out;
}

function words(plan: RestorePlan, kept: Record<string, number>, refilled: number, dry: boolean): string {
  const n = (a: PlannedColumn['action']) => plan.columns.filter(c => c.action === a).length;
  const rows = Object.values(kept).reduce((a, b) => a + b, 0);
  const free = (k: number) => `${countOf(k, 'formula, clean or lookup column')}`;
  const parts = dry ? [
    n('restore') && `set up ${countOf(n('restore'), 'column')} as in the test`,
    n('add_back') && `add ${countOf(n('add_back'), 'column')}`,
    rows && `keep the results of ${countOf(rows, 'sample row')}`,
    refilled && `fill ${free(refilled)} again on every row (free)`,
  ] : [
    n('restore') && `${countOf(n('restore'), 'column')} set up as in the test`,
    n('add_back') && `${countOf(n('add_back'), 'column')} added`,
    rows && `the results of ${countOf(rows, 'sample row')} kept`,
    refilled && `${free(refilled)} filling again (free)`,
  ];
  const said = parts.filter((p): p is string => !!p);
  if (!said.length) return dry ? 'Nothing to apply: the copy is set up as the sheet is. Applying closes the test.'
    : 'Nothing changed: the copy was set up as the sheet is. The test is closed.';
  const list = said.length === 1 ? said[0] : `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`;
  return dry ? `Applying will ${list}.`
    : `Applied: ${list}. The setup before is saved as a version. Nothing ran on the other rows.`;
}

class DryRun extends Error { constructor(readonly answer: ApplyAnswer) { super('dry run'); } }

interface Applied { answer: ApplyAnswer; turnOn: string[]; byName: Map<string, VersionSpec['columns'][number]>;
  plan: RestorePlan; paused: string[]; fills: Array<[DerivedName, string, string]> }

// The whole apply, in the caller's transaction (thrown back out as DryRun for a dry run).
function applyInTxn(t: TestRecord, opts: { dryRun: boolean; hasSecretsScope: boolean }): Applied {
  const live = snapshotSheet(t.sheet_id, t.user_id);
  const spec = testSpec(t, live);
  const plan = planRestore(t.sheet_id, t.user_id, spec, fieldContext(t.user_id, false));
  const inCopy = new Set(spec.columns.map(c => c.name));
  const blocked = problem(t, plan, opts.hasSecretsScope);
  const base = { test: testView(t), dry_run: opts.dryRun, columns: plan.columns,
    not_in_test: live.columns.map(c => c.name).filter(c => !inCopy.has(c)) };
  if (blocked && opts.dryRun) {
    throw new DryRun({ ...base, nothing: plan.nothing, blocked: blocked.message, results_kept: {},
      worked_out_again: [], saved_before: null, message: blocked.message });
  }
  if (blocked) throw new RestoreRefused(blocked);
  let before: VersionInfo | null = null;
  const byName = new Map(spec.columns.map(c => [c.name, c]));
  const paused = pausedByHand(t.sheet_id, t.user_id);
  let turnOn: string[] = [];
  if (!plan.nothing) {
    const saved = insertVersion(t.sheet_id, t.user_id, live, 'Before applying a test', null, true);
    if ('fail' in saved) throw new RestoreRefused(saved);
    before = saved;
    turnOn = writePlan(t.sheet_id, t.user_id, plan, byName, { hasSecretsScope: opts.hasSecretsScope, paused });
  }
  const kept = keepTestResults(t, plan.writes.fills);
  const fills = refill(t, plan.writes.fills);
  const message = words(plan, kept, fills.length, opts.dryRun);
  const answer: ApplyAnswer = { ...base, nothing: plan.nothing && !Object.keys(kept).length, blocked: null,
    results_kept: kept, worked_out_again: fills.map(f => f[2]), saved_before: before, message };
  if (opts.dryRun) throw new DryRun(answer);
  markEnding(t, 'applied');
  logSheetChange(t.sheet_id, t.user_id, 'test_applied', `Applied the test of changes on sample rows: ${message}`, {
    detail: { saved_before: before?.id ?? null, results_kept: kept, ...Object.fromEntries(
      (['add_back', 'restore'] as const).map(a => [a, plan.columns.filter(c => c.action === a).map(c => c.column)])) },
  });
  return { answer, turnOn, byName, plan, paused, fills };
}

function refusalNow(t: TestRecord | null): RunFail | null {
  if (!t) return { fail: 'not_found', message: 'No test is open on this sheet.' };
  if (t.state !== 'open') return conflict('This test is closing already.');
  const going = sheetWorkGoing(t.test_sheet_id, t.user_id);
  if (going && 'run' in going) {
    return conflict('A run is going on the test copy. Let it finish or stop it, then apply.');
  }
  if (going) return conflict(`"${going.filling}" is still being filled on the test copy. Let it finish, then apply.`);
  const busy = sheetBusyWith(t.test_sheet_id);
  return busy ? conflict(`The test copy is busy ${busy}. Try again when that finishes.`) : null;
}

export async function applySheetTest(
  userId: string, sheetId: string, opts: { dryRun: boolean; hasSecretsScope: boolean },
): Promise<{ ok: ApplyAnswer } | RunFail> {
  const first = testOfSheet(sheetId, userId);
  const refused = refusalNow(first);
  if (refused || !first) return refused!;
  const run = (): Applied | RunFail => {
    try {
      return db.transaction(() => {
        const t = testOfSheet(first.sheet_id, userId);
        const now = refusalNow(t);
        if (now) throw new RestoreRefused(now);
        return applyInTxn(t!, opts);
      }).immediate();
    } catch (e) {
      if (e instanceof DryRun) return { answer: e.answer } as Applied;
      if (e instanceof RestoreRefused) return e.out;
      throw e;
    }
  };
  if (opts.dryRun) {
    const out = run();
    return 'fail' in out ? out : { ok: out.answer };
  }
  type Out = { ok: ApplyAnswer } | RunFail;
  const out = await withSheetBusy(first.sheet_id, 'applying a test', async (): Promise<Out> => {
    const done = run();
    if ('fail' in done) return done;
    releaseTestHold(first.sheet_id);
    const t = testOfSheet(first.sheet_id, userId) ?? first;
    finishEnding(t);
    await turnAutoRunsOn(first.sheet_id, userId, done.turnOn, done.byName,
      { hasSecretsScope: opts.hasSecretsScope, paused: done.paused }, done.plan);
    if (done.fills.length) {
      continueInBackground(first.sheet_id, DERIVED[done.fills[0][0]].busy, async () => {
        for (const [kind, id] of done.fills) await runDerivedFill(DERIVED[kind] as never, id);
      });
    }
    return { ok: { ...done.answer, test: testView(t) } };
  }, { pastTest: true });
  return 'busy' in out && typeof out.busy === 'string' ? conflict(out.busy) : out as { ok: ApplyAnswer } | RunFail;
}
