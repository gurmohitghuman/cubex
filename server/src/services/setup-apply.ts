// Using a setup on a sheet: fitted to the sheet (inputs matched, steps
// renamed, lib/setups/apply-plan.ts), checked against what the account has (the
// saved keys it names, a column of the same name that would be read in a key's
// place, the AI models), then either priced (estimateOnly: a pure read) or
// started: a setup_runs record, whose first layer starts at once and the rest
// as the ones before finish (setup-runner.ts). A token without 'secrets' can't
// use a setup whose requests read a saved key. firstRows tests it on the top
// rows of the sheet (auto-run isn't turned on after a test).
import { db } from '../lib/db';
import { MAX_SETUP_TEST_ROWS } from '../lib/constants-setups';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { resolveAiModel } from '../lib/ai-model-resolve';
import { fetchModels } from '../lib/openrouter';
import { savedKeyRefsInConfig } from '../lib/http-secrets-scan';
import { templateTokenIs } from '../lib/template-token-match';
import { planApply, type ApplyChoices } from '../lib/setups/apply-plan';
import { mainColumn, stepColumns, type SetupSpec } from '../lib/setups/spec';
import { getSetup } from './setup-library';
import { savedKeyNames } from './saved-keys';
import { estimateSetup, type SetupEstimate } from './setup-estimate';
import { insertSetupRun, getSetupRun, planOf, type SetupRunRow, type SetupRunView } from './setup-run-store';
import { advanceSetupRun } from './setup-runner';
import type { RunFail } from './run-shared';

export interface ApplyInput extends ApplyChoices {
  models?: Record<string, string>; // an AI step's main column → the model it runs on
  firstRows?: number | null;       // test on the top rows; null/undefined: every row
  estimateOnly: boolean;
}
export type ApplyFail = RunFail & { missing?: string[]; taken?: string[] };
export type ApplyOutcome =
  | { ok: { estimate: SetupEstimate; inputs: Record<string, string>; makes: string[] } }
  | { ok: { setup_run: SetupRunView } }
  | ApplyFail;

const bad = (message: string): ApplyFail => ({ fail: 'bad_request', message });
const list = (names: string[]) => names.map(n => `"${n}"`).join(', ');

async function withModels(spec: SetupSpec, models: Record<string, string>, sheetId: string, userId: string)
  : Promise<SetupSpec | ApplyFail> {
  const steps = spec.steps.map(s => (s.kind === 'ai' && models[mainColumn(s)]
    ? { ...s, model: models[mainColumn(s)].trim() } : s));
  const catalog = await fetchModels(Date.now());
  for (const s of steps) {
    if (s.kind !== 'ai') continue;
    const model = resolveAiModel(s.model ?? undefined, sheetId, userId);
    if (!model) return bad(`Pick a model for "${mainColumn(s)}": there's no default model to use.`);
    if (catalog.ok && !catalog.models.some(m => m.id === model)) {
      return bad(`The model "${model}" of "${mainColumn(s)}" isn't on OpenRouter anymore. Pick another.`);
    }
  }
  return { ...spec, steps };
}

// Saved keys the setup's requests read: they must exist, no column may stand
// in their place, and a token needs 'secrets' to use them.
function keyProblem(userId: string, spec: SetupSpec, columns: string[], hasSecretsScope: boolean): ApplyFail | null {
  const saved = new Set(savedKeyNames(userId));
  const missing = spec.keys.filter(k => !saved.has(k));
  if (missing.length) {
    return bad(`Add the saved key${missing.length > 1 ? 's' : ''} ${list(missing)} in Settings first.`);
  }
  const all = [...columns, ...spec.steps.flatMap(stepColumns)];
  const shadowed = spec.keys.find(k => all.some(c => templateTokenIs(k, c)));
  if (shadowed) return bad(`A column named like the saved key "${shadowed}" would be read in its place. Rename it.`);
  const reads = spec.steps.flatMap(s => (s.kind === 'http' ? savedKeyRefsInConfig(userId, {
    method: s.request.method, url: s.request.url, headers: s.request.headers, body: s.request.body ?? undefined,
  }) : []));
  if (reads.length && !hasSecretsScope) {
    return { fail: 'forbidden', message: `This setup's requests read saved keys (${list([...new Set(reads)])}). `
      + 'The access token needs the \'secrets\' scope.' };
  }
  return null;
}

export async function applySetup(
  userId: string, sheetId: string, setupId: string, input: ApplyInput, caller: { hasSecretsScope: boolean },
): Promise<ApplyOutcome> {
  const setup = getSetup(userId, setupId);
  if (!setup) return { fail: 'not_found', message: 'Setup not found' };
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  if (setup.spec.steps.length === 0) return bad('This setup is damaged: it has no steps. Save it again.');
  const first = input.firstRows ?? null;
  if (first !== null && !(Number.isSafeInteger(first) && first >= 1 && first <= MAX_SETUP_TEST_ROWS)) {
    return bad(`firstRows must be a whole number from 1 to ${MAX_SETUP_TEST_ROWS}.`);
  }
  const columns = getSheetColumns(sheetId, userId, false);
  // Models first: they're picked by the setup's own column names, before any rename.
  const modeled = await withModels(setup.spec, input.models ?? {}, sheetId, userId);
  if ('fail' in modeled) return modeled;
  const plan = planApply(modeled, columns, input);
  if ('problem' in plan) {
    return { fail: plan.taken ? 'conflict' : 'bad_request', message: plan.problem, missing: plan.missing,
      taken: plan.taken };
  }
  const spec = plan.ok.spec;
  const keys = keyProblem(userId, spec, columns, caller.hasSecretsScope);
  if (keys) return keys;
  // Another setup still working on this sheet will make its later columns: none may be the same.
  const live = db.prepare(`SELECT * FROM setup_runs WHERE sheet_id = ? AND user_id = ?
    AND status IN ('running', 'paused')`).all(sheetId, userId) as SetupRunRow[];
  const coming = new Set(live.flatMap(r => planOf(r).spec.steps.flatMap(stepColumns)).map(c => c.toLowerCase()));
  const clash = plan.ok.makes.filter(c => coming.has(c.toLowerCase()));
  if (clash.length) {
    return { fail: 'conflict', taken: clash,
      message: `Another setup working on this sheet will make ${list(clash)}. Give those steps other names.` };
  }

  const rowIds = first === null ? null : db.prepare(`SELECT id FROM rows WHERE sheet_id = ? AND user_id = ?
    ORDER BY row_index LIMIT ?`).pluck().all(sheetId, userId, first) as string[];
  const rows = rowIds ? rowIds.length
    : db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ?').pluck().get(sheetId, userId) as number;
  if (rows === 0) return bad('This sheet has no rows yet. Import or add rows first, then use the setup.');
  const layered = { spec, layers: plan.ok.layers };

  if (input.estimateOnly) {
    const indexes = rowIds ? db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ?
      ORDER BY row_index LIMIT ?`).pluck().all(sheetId, userId, first) as number[] : null;
    const estimate = await estimateSetup(userId, sheetId, layered, columns, rows, indexes);
    return { ok: { estimate, inputs: plan.ok.inputs, makes: plan.ok.makes } };
  }
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  const id = insertSetupRun({
    userId, sheetId, setupId: setup.id, setupName: setup.name, plan: layered, targetRowIds: rowIds,
    allowSecrets: caller.hasSecretsScope, autoRun: rowIds === null,
  });
  // The first layer starts now; the sweep carries on if this round can't (it's logged, not the caller's error).
  try {
    await advanceSetupRun(id);
  } catch (err) {
    console.error(`Setup run ${id} couldn't start its first steps yet:`, err);
  }
  return { ok: { setup_run: getSetupRun(userId, id)! } };
}
