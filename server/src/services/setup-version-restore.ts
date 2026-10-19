// Restoring a setup version (the plan: setup-version-plan.ts; the writes:
// setup-version-apply.ts and setup-version-write.ts). With the sheet busy
// and in one transaction, it first keeps the setup it replaces as a version of
// its own ("Before restoring: …"), then adds the version's gone columns back
// empty and writes back each setup that differs, the descriptions, auto-run
// and the order. Nothing runs and nothing is billed; no cell is touched. It
// waits for no run: one going on the sheet (or a setup filling it, or a clean,
// formula or lookup column still filling) refuses it.
// A paid column's auto-run goes back on through the auto-run settings' own
// checks after the transaction; one they refuse stays off and says why. A dry
// run answers what a restore would do, and `blocked`: why it can't now.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { busyMessage, sheetBusyWith, withSheetBusy } from '../lib/sheet-busy';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { MAX_SETUP_NAME_CHARS, MAX_SETUP_VERSIONS_PER_SHEET } from '../lib/constants-setups';
import { httpRunSecretRefsRequiringScope } from '../lib/http-secrets-scan';
import { logSheetChange } from '../lib/change-log';
import { finishRunRewrites } from './run-config-rewrite';
import { insertVersion, readSetupVersion, type VersionInfo } from './setup-version-store';
import { snapshotSheet } from './setup-version-snapshot';
import { fieldContext, planRestore, type PlannedColumn, type RestorePlan } from './setup-version-plan';
import { pausedByHand, RestoreRefused, turnAutoRunsOn, writePlan } from './setup-version-apply';
import type { RunFail } from './run-shared';

export interface RestoreAnswer {
  version: VersionInfo; dry_run: boolean; nothing: boolean; blocked: string | null; columns: PlannedColumn[];
  unchanged: number; order_changed: boolean; saved_before: VersionInfo | null; message: string;
}

const RUNS_ACTIVE = `SELECT 1 FROM ai_runs WHERE sheet_id = ? AND user_id = ?
    AND (status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL)
  UNION ALL SELECT 1 FROM http_runs WHERE sheet_id = ? AND user_id = ?
    AND (status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL)
  UNION ALL SELECT 1 FROM setup_runs WHERE sheet_id = ? AND user_id = ? AND status IN ('running', 'paused')
  LIMIT 1`;
// A clean, formula or lookup column being filled (a lookup's may wait, its sheet
// free, for the other sheet): a restore writing its record back would end it.
const FILLING = `SELECT column_name FROM clean_columns WHERE sheet_id = ? AND user_id = ? AND fill_status = 'filling'
  UNION ALL SELECT column_name FROM formula_columns WHERE sheet_id = ? AND user_id = ? AND fill_status = 'filling'
  UNION ALL SELECT column_name FROM lookup_columns WHERE sheet_id = ? AND user_id = ? AND fill_status = 'filling'
  LIMIT 1`;
const KEYS = "A request it puts back reads saved API keys: restoring it needs the 'secrets' scope.";

// Why the restore can't happen now (the restore refuses; a dry run says so).
function refusal(
  sheetId: string, userId: string, versionId: string, plan: RestorePlan, hasSecretsScope: boolean,
): RunFail | null {
  if (db.prepare(RUNS_ACTIVE).get(sheetId, userId, sheetId, userId, sheetId, userId)) {
    return { fail: 'conflict', message: 'A run is going on this sheet, or a saved setup is filling it. Stop it or '
      + 'let it finish, then restore.' };
  }
  const filling = db.prepare(FILLING).pluck().get(sheetId, userId, sheetId, userId, sheetId, userId) as
    string | undefined;
  if (filling) {
    return { fail: 'conflict', message: `"${filling}" is still being filled (or waits for the sheet it looks in). `
      + 'Let it finish, then restore.' };
  }
  if (plan.loop) return { fail: 'conflict', message: plan.loop };
  const columns = getSheetColumns(sheetId, userId, false).length;
  if (columns + plan.writes.addBack.length > MAX_COLUMNS_PER_SHEET) {
    return { fail: 'cap', message: `Adding back ${plan.writes.addBack.length} columns would pass the column limit `
      + `(${MAX_COLUMNS_PER_SHEET} per sheet). Delete unused columns first.` };
  }
  const versions = db.prepare(`SELECT COUNT(*) AS n, SUM(auto = 1 AND id != ?) AS spare FROM setup_versions
    WHERE sheet_id = ? AND user_id = ?`).get(versionId, sheetId, userId) as { n: number; spare: number | null };
  if (versions.n >= MAX_SETUP_VERSIONS_PER_SHEET && !versions.spare) {
    return { fail: 'conflict', message: `A sheet keeps at most ${MAX_SETUP_VERSIONS_PER_SHEET} setup versions, and `
      + 'restoring saves the current setup as one first. Delete a version, then restore.' };
  }
  if (hasSecretsScope) return null;
  // A paid column whose setup it writes, or whose auto-run it turns on, can't read a saved key for such a caller.
  for (const [column, v] of [...plan.writes.fills].map(([c, f]) => [c, f] as const)
    .concat([...plan.writes.autoRuns].filter(([, v]) => !!v.autoRun && !!v.fill).map(([c, v]) => [c, v.fill!]))) {
    if (v.kind !== 'http') continue;
    const refs = httpRunSecretRefsRequiringScope(userId,
      { config: JSON.stringify(v.config), allow_secrets: v.allowSecrets }, false);
    if (refs.length) return { fail: 'forbidden', message: `"${column}": ${KEYS}` };
  }
  return null;
}

function said(plan: RestorePlan, done: boolean): string {
  const n = (a: PlannedColumn['action']) => plan.columns.filter(c => c.action === a).length;
  const cols = (k: number) => `${k} column${k === 1 ? '' : 's'}`;
  const [back, set, left] = [n('add_back'), n('restore'), n('leave')];
  const parts = done ? [back && `${cols(back)} added back (empty)`,
    set && `${cols(set)} set up as ${set === 1 ? 'it was' : 'they were'}`,
    left && `${cols(left)} left as ${left === 1 ? 'it is' : 'they are'}`,
    plan.orderChanged && "the columns back in the version's order"]
    : [back && `adds back ${cols(back)} (empty)`,
      set && `sets up ${cols(set)} as ${set === 1 ? 'it was' : 'they were'}`,
      left && `leaves ${cols(left)} as ${left === 1 ? 'it is' : 'they are'}`,
      plan.orderChanged && "puts the columns back in the version's order"];
  const words = parts.filter((p): p is string => !!p);
  if (!words.length) return done ? "auto-run set as in the version" : "sets auto-run as the version has it";
  const last = words[words.length - 1];
  return words.length === 1 ? last : `${words.slice(0, -1).join(', ')}${done ? ', ' : ' and '}${last}`;
}

const nothingSaid = (plan: RestorePlan) => (plan.columns.some(c => c.action === 'leave')
  ? 'Nothing can be restored: the only differences are columns a restore leaves as they are (below).'
  : 'Nothing to restore: the columns in this version are set up the way it has them.');

const beforeName = (name: string) => {
  const full = `Before restoring: ${name}`;
  return full.length <= MAX_SETUP_NAME_CHARS ? full : `${full.slice(0, MAX_SETUP_NAME_CHARS - 1)}…`;
};

export async function restoreSetupVersion(
  sheetId: string, userId: string, versionId: string,
  opts: { dryRun: boolean; hasSecretsScope: boolean; reveal: boolean },
): Promise<{ ok: RestoreAnswer } | RunFail> {
  const read = readSetupVersion(sheetId, userId, versionId);
  if ('fail' in read) return read;
  const ctx = fieldContext(userId, opts.reveal);
  const answer = (plan: RestorePlan, dry: boolean, before: VersionInfo | null, message: string,
    blocked: string | null = null): RestoreAnswer => ({
    version: read.info, dry_run: dry, nothing: plan.nothing, blocked, columns: plan.columns,
    unchanged: plan.unchanged, order_changed: plan.orderChanged, saved_before: before, message,
  });
  const first = planRestore(sheetId, userId, read.spec, ctx);
  if (first.nothing) return { ok: answer(first, opts.dryRun, null, nothingSaid(first)) };
  if (opts.dryRun) {
    const problem = refusal(sheetId, userId, versionId, first, opts.hasSecretsScope);
    return { ok: answer(first, true, null, `Restoring this version ${said(first, false)}.`, problem?.message ?? null) };
  }
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  type Out = { ok: RestoreAnswer } | RunFail;
  const out = await withSheetBusy(sheetId, 'restoring a setup version', async (): Promise<Out> => {
    await finishRunRewrites(sheetId);
    const paused = pausedByHand(sheetId, userId);
    let plan!: RestorePlan;
    let before!: VersionInfo;
    let turnOn: string[] = [];
    let byName = new Map(read.spec.columns.map(c => [c.name, c]));
    try {
      db.transaction(() => {
        // Read and planned again inside the write lock: the version (a rename rewrites it) and the
        // sheet may have changed since the first look.
        const fresh = readSetupVersion(sheetId, userId, versionId);
        if ('fail' in fresh) throw new RestoreRefused(fresh);
        byName = new Map(fresh.spec.columns.map(c => [c.name, c]));
        plan = planRestore(sheetId, userId, fresh.spec, ctx);
        if (plan.nothing) return;
        const problem = refusal(sheetId, userId, versionId, plan, opts.hasSecretsScope);
        if (problem) throw new RestoreRefused(problem);
        const saved = insertVersion(sheetId, userId, snapshotSheet(sheetId, userId), beforeName(read.info.name), null,
          true, versionId);
        if ('fail' in saved) throw new RestoreRefused(saved);
        before = saved;
        turnOn = writePlan(sheetId, userId, plan, byName, { hasSecretsScope: opts.hasSecretsScope, paused });
        logSheetChange(sheetId, userId, 'setup_version_restored', `Restored the setup version "${read.info.name}"`, {
          detail: { version_id: read.info.id, saved_before: before.id, ...Object.fromEntries(
            (['add_back', 'restore', 'leave'] as const).map(a => [a, plan.columns.filter(c => c.action === a)
              .map(c => c.column)])) },
        });
      }).immediate();
    } catch (e) {
      if (e instanceof RestoreRefused) return e.out;
      throw e;
    }
    if (plan.nothing) return { ok: answer(plan, false, null, nothingSaid(plan)) };
    await turnAutoRunsOn(sheetId, userId, turnOn, byName, { hasSecretsScope: opts.hasSecretsScope, paused }, plan);
    return { ok: answer(plan, false, before, `Restored. ${said(plan, true)}. Your previous setup is saved as a `
      + 'version, so you can switch back. Nothing ran: each column\'s note says how to fill it.') };
  });
  return 'busy' in out && typeof out.busy === 'string' ? { fail: 'conflict', message: out.busy } : out as Out;
}
