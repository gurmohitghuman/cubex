// Saving a setup from a sheet: the filled columns asked for (any column a
// step made picks that step) and, unless includeUpstream is false, every
// filled column they read, down the chain. Each step as its column is set up
// now (setup-steps.ts); the columns it reads that no chosen step makes become
// the setup's inputs, the saved keys its requests name are listed by name.
// The steps are stored in an order where each follows what it reads. A
// column that can't be saved (a reference to nothing, a key typed into its
// request, a list enrichment) is refused when asked for, and left out when
// only read: what it made becomes an input. planSetup is the same work
// without saving: what the dialog shows first.
import { MAX_SETUP_STEPS } from '../lib/constants-setups';
import { verifySheetOwnership, getSheetColumns } from '../lib/sql-helpers';
import { columnLookup, stepReads, type StepReads } from '../lib/setups/refs';
import { typedKeyIn, typedKeyMessage } from '../lib/setups/typed-key';
import { orderSteps } from '../lib/setups/graph';
import { remapStep } from '../lib/setups/remap';
import { specProblem, stepLabel } from '../lib/setups/check';
import { stepColumns, type SetupSpec } from '../lib/setups/spec';
import { savedKeyNames } from './saved-keys';
import { sheetCandidates, type Candidate } from './setup-steps';
import { insertSetup, setupDescription, setupName, type SetupDetail } from './setup-library';
import type { RunFail } from './run-shared';

export interface SaveSetupInput { name?: unknown; description?: unknown; columns: unknown; includeUpstream?: unknown }

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// What a sheet's step reads, or why it can't go in a setup.
function readsOf(c: Candidate, listed: string[], keys: Set<string>): { reads: StepReads } | { problem: string } {
  if (c.problem || !c.step) return { problem: c.problem ?? 'It can\'t go in a setup.' };
  const reads = stepReads(c.step, listed, keys);
  if (reads.problems.length) return { problem: reads.problems[0] };
  if (c.step.kind === 'http') {
    const find = columnLookup(listed);
    const where = typedKeyIn(c.step.request, n => find.template(n) !== undefined || keys.has(n));
    if (where) return { problem: typedKeyMessage(where) };
  }
  return { reads };
}

// What the sheet's filled columns are, for the dialog: each one, what it reads.
export interface SheetStepView {
  kind: Candidate['kind']; column: string; columns: string[]; reads: string[]; problem: string | null;
}

export function sheetSteps(userId: string, sheetId: string): { ok: SheetStepView[] } | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const listed = getSheetColumns(sheetId, userId, false);
  const keys = new Set(savedKeyNames(userId));
  return {
    ok: sheetCandidates(sheetId, userId).map(c => {
      const r = readsOf(c, listed, keys);
      return {
        kind: c.kind, column: c.columns[0], columns: c.columns,
        reads: 'reads' in r ? r.reads.columns : [], problem: 'problem' in r ? r.problem : null,
      };
    }),
  };
}

export function planSetup(
  userId: string, sheetId: string, columnsRaw: unknown, includeUpstream = true,
): { ok: SetupSpec } | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  if (!Array.isArray(columnsRaw) || columnsRaw.length === 0 || columnsRaw.some(c => typeof c !== 'string')) {
    return bad('columns: name the filled columns to save, like ["Score (Output)"].');
  }
  const listed = getSheetColumns(sheetId, userId, false);
  const keys = new Set(savedKeyNames(userId));
  const candidates = sheetCandidates(sheetId, userId);
  const owner = (column: string) => candidates.find(c => c.columns.includes(column));
  const reads = new Map<Candidate, StepReads>();
  for (const column of columnsRaw as string[]) {
    const c = owner(column);
    if (!c) {
      return bad(listed.includes(column)
        ? `"${column}" isn't a filled column. A setup holds AI, HTTP API, enrichment, clean and formula columns.`
        : `There's no column named "${column}".`);
    }
    const r = readsOf(c, listed, keys);
    if ('problem' in r) return bad(`"${column}": ${r.problem}`);
    reads.set(c, r.reads);
  }

  // The filled columns the chosen ones read join, down the chain; one that
  // can't be saved stays out (what it made is an input).
  const queue = includeUpstream ? [...reads.keys()] : [];
  while (queue.length) {
    for (const col of reads.get(queue.shift()!)!.columns) {
      const up = owner(col);
      if (!up || reads.has(up)) continue;
      const r = readsOf(up, listed, keys);
      if ('reads' in r) { reads.set(up, r.reads); queue.push(up); }
    }
  }
  const chosen = [...reads.keys()];
  if (chosen.length > MAX_SETUP_STEPS) return bad(`A setup can have at most ${MAX_SETUP_STEPS} steps.`);

  // A renamed AI column goes back to the name its run makes, in every chosen step that reads it.
  const renames = new Map(chosen.flatMap(c => c.renames));
  const list = chosen;
  const steps = list.map(c => (renames.size ? remapStep(c.step!, renames, listed) : c.step!));
  const graph = list.map((c, i) => ({
    label: stepLabel(steps[i]), makes: stepColumns(steps[i]),
    reads: reads.get(c)!.columns.map(col => renames.get(col) ?? col),
  }));
  const ordered = orderSteps(graph);
  if ('problem' in ordered) return bad(ordered.problem);
  const spec: SetupSpec = {
    v: 1, inputs: ordered.ok.inputs,
    keys: [...new Set(list.flatMap(c => reads.get(c)!.keys))].sort(),
    steps: ordered.ok.order.map(i => steps[i]),
  };
  const problem = specProblem(spec);
  return problem ? bad(problem) : { ok: spec };
}

export function saveSetup(userId: string, sheetId: string, input: SaveSetupInput): { ok: SetupDetail } | RunFail {
  const name = setupName(input.name);
  if (typeof name !== 'string') return name;
  const description = setupDescription(input.description);
  if (description !== null && typeof description !== 'string') return description;
  if (input.includeUpstream !== undefined && typeof input.includeUpstream !== 'boolean') {
    return bad('includeUpstream must be true or false.');
  }
  const plan = planSetup(userId, sheetId, input.columns, input.includeUpstream !== false);
  if ('fail' in plan) return plan;
  return insertSetup(userId, name, description, plan.ok);
}
