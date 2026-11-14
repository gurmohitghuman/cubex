// What the saved setup tools answer (tools-setups.ts, tools-setup-runs.ts, tools-setup-versions.ts).
import { z } from 'zod';
import { obj, open } from '../output-schema';
import { bool, info, nul, num, opt, str, strs } from './shared';

const setupFields = {
  id: str, name: str, description: nul(str), inputs: strs.describe('The input names the setup reads'),
  keys: z.array(str).describe('Saved keys its steps use'), steps: z.array(info('A column the setup makes')),
  use_count: num, last_used_at: nul(str), created_at: str, updated_at: str,
};
const setup = obj(setupFields);
// No setup_id: setups. With one: that setup and its spec.
export const listSetups = obj({
  setups: opt(z.array(setup)), ...setup.partial().shape, spec: opt(info('The setup as save_setup takes it')),
});
export const saveSetup = obj({
  ...setup.partial().shape, inputs: setupFields.inputs, keys: setupFields.keys, steps: setupFields.steps,
  spec: info('The setup as save_setup takes it'),
});
export const deleteSetup = obj({ deleted: str });

const setupRun = obj({
  id: str, setup_id: str, setup_name: str, sheet_id: str, status: str, layer: num, layers: num,
  test_rows: nul(num), error_message: nul(str), created_at: str, updated_at: str,
  choices: info('What the call chose: rows, test, spend limits'), webhook_id: nul(str),
  steps: z.array(obj({
    column: str, kind: str, layer: num, mode: str, state: str, run_id: nul(str), note: nul(str),
  })),
  max_cost_usd: opt(num),
});
// estimate_only (its default): estimate, inputs, makes and carries_on. Started: setup_run.
export const applySetup = obj({
  setup_run: opt(setupRun), estimate: opt(info('What it would cost, by column')),
  inputs: opt(info('Input -> the column it reads')), makes: opt(strs).describe('The columns it would make'),
  carries_on: opt(strs).describe('The columns it carries on'),
});
// No setup_run_id: setup_runs. With one: that setup run.
export const getSetupRun = obj({ setup_runs: opt(z.array(setupRun)), ...setupRun.partial().shape });
export const controlSetupRun = setupRun;

const version = obj({
  id: str, name: str, description: nul(str), auto: bool, by: str, saved_at: str, columns: num, filled: num,
});
const restore = {
  version: opt(info('The version restored')), dry_run: opt(bool), nothing: opt(bool), blocked: opt(nul(str)),
  columns: opt(z.array(info('A column and what the restore does to it'))), unchanged: opt(num),
  order_changed: opt(bool), saved_before: opt(nul(info('The version saved of the sheet before'))), message: opt(str),
};
export const listSetupVersions = obj({ versions: opt(z.array(version)), ...restore });
export const manageSetupVersion = open({ version: opt(version), ok: opt(bool) });
export const restoreSetupVersion = obj({ ...restore, version: info('The version restored') });
