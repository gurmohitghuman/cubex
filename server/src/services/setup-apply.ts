// Using a setup on a sheet: fitted to the sheet (inputs matched, steps
// renamed, lib/setups/apply-plan.ts), where a step whose column the sheet has
// already, made the same way, carries it on (fills only the rows it hasn't
// done) instead of being refused; checked against what the account has (the
// saved keys it names, a column of the same name that would be read in a
// key's place, the AI models, setup-apply-checks.ts), then either priced
// (estimateOnly: a pure read) or started: a setup_runs record, whose first
// layer starts at once and the rest as the ones before finish
// (setup-runner.ts). A token without 'secrets' can't use a setup whose
// requests read a saved key. firstRows tests it on the top rows of the sheet
// (auto-run isn't turned on after a test).
import { db } from '../lib/db';
import { MAX_SETUP_TEST_ROWS } from '../lib/constants-setups';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { planApply, type ApplyChoices } from '../lib/setups/apply-plan';
import { mainColumn } from '../lib/setups/spec';
import { getSetup } from './setup-library';
import { savedKeyNames } from './saved-keys';
import { sheetCandidates } from './setup-steps';
import { estimateSetup, type SetupEstimate } from './setup-estimate';
import { insertSetupRun, getSetupRun, type SetupRunView } from './setup-run-store';
import { advanceSetupRun } from './setup-runner';
import { keyProblem, liveSetupClash, withModels, type ApplyFail } from './setup-apply-checks';
import { webhookIdProblem } from './run-hooks-attach';
import { countOf, logSheetChange } from '../lib/change-log';

export type { ApplyFail } from './setup-apply-checks';

export interface ApplyInput extends ApplyChoices {
  models?: Record<string, string>; // an AI step's main column → the model it runs on
  firstRows?: number | null;       // test on the top rows; null/undefined: every row
  estimateOnly: boolean;
  webhookId?: string | null;       // a run webhook told when the setup finishes (REST/MCP)
}
// makes: every column its steps make or carry on; carries_on: the main columns
// of the steps that carry a column of the sheet on.
export type ApplyOutcome =
  | { ok: { estimate: SetupEstimate; inputs: Record<string, string>; makes: string[]; carries_on: string[] } }
  | { ok: { setup_run: SetupRunView } }
  | ApplyFail;

const bad = (message: string): ApplyFail => ({ fail: 'bad_request', message });

export async function applySetup(
  userId: string, sheetId: string, setupId: string, input: ApplyInput, caller: { hasSecretsScope: boolean },
): Promise<ApplyOutcome> {
  const setup = getSetup(userId, setupId);
  if (!setup) return { fail: 'not_found', message: 'Setup not found' };
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  if (setup.spec.steps.length === 0) return bad('This setup is damaged: it has no steps. Save it again.');
  const hookProblem = webhookIdProblem(userId, input.webhookId);
  if (hookProblem) return bad(hookProblem);
  const first = input.firstRows ?? null;
  if (first !== null && !(Number.isSafeInteger(first) && first >= 1 && first <= MAX_SETUP_TEST_ROWS)) {
    return bad(`firstRows must be a whole number from 1 to ${MAX_SETUP_TEST_ROWS}.`);
  }
  const columns = getSheetColumns(sheetId, userId, false);
  const existing = sheetCandidates(sheetId, userId);
  const plan = planApply(setup.spec, columns, input, existing, new Set(savedKeyNames(userId)));
  if ('problem' in plan) {
    return { fail: plan.taken ? 'conflict' : 'bad_request', message: plan.problem, missing: plan.missing,
      taken: plan.taken };
  }
  const { modes, layers, makes } = plan.ok;
  // Models are picked by the setup's own column names, before any rename.
  const spec = await withModels(plan.ok.spec, setup.spec, input.models ?? {}, modes, existing, sheetId, userId);
  if ('fail' in spec) return spec;
  const problem = keyProblem(userId, spec, columns, caller.hasSecretsScope) ?? liveSetupClash(userId, sheetId, makes);
  if (problem) return problem;

  const rowIds = first === null ? null : db.prepare(`SELECT id FROM rows WHERE sheet_id = ? AND user_id = ?
    ORDER BY row_index LIMIT ?`).pluck().all(sheetId, userId, first) as string[];
  const rows = rowIds ? rowIds.length
    : db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ?').pluck().get(sheetId, userId) as number;
  if (rows === 0) return bad('This sheet has no rows yet. Import or add rows first, then use the setup.');
  const layered = { spec, layers, modes };

  if (input.estimateOnly) {
    const indexes = rowIds ? db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ?
      ORDER BY row_index LIMIT ?`).pluck().all(sheetId, userId, first) as number[] : null;
    const estimate = await estimateSetup(userId, sheetId, layered, columns, rows, indexes, existing);
    const carries = spec.steps.filter((_, i) => modes[i] === 'again').map(mainColumn);
    return { ok: { estimate, inputs: plan.ok.inputs, makes, carries_on: carries } };
  }
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  const choices = { inputs: plan.ok.inputs, names: input.names ?? {}, models: input.models ?? {} };
  const id = insertSetupRun({
    userId, sheetId, setupId: setup.id, setupName: setup.name, plan: { ...layered, choices }, targetRowIds: rowIds,
    allowSecrets: caller.hasSecretsScope, autoRun: rowIds === null, webhookId: input.webhookId ?? null,
  });
  logSheetChange(sheetId, userId, 'setup_used',
    `Used the setup "${setup.name}"${rowIds ? ` on the first ${countOf(rowIds.length, 'row')}` : ''}`,
    { detail: { setup_id: setup.id, setup_run_id: id, makes } });
  // The first layer starts now; the sweep carries on if this round can't (it's logged, not the caller's error).
  try {
    await advanceSetupRun(id);
  } catch (err) {
    console.error(`Setup run ${id} couldn't start its first steps yet:`, err);
  }
  return { ok: { setup_run: getSetupRun(userId, id)! } };
}
