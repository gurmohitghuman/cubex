// Checking a setup (pure). readSpec takes JSON from anywhere (a file someone
// imports) and returns a SetupSpec, or what's wrong with it, in words: the
// shape of every step, then specProblem: the steps in an order where each
// one's references resolve to an input or a column an earlier step makes (or,
// in a request, a saved key the setup names), no two steps make one column,
// and no step reads its own. Using a setup checks each step again against
// the sheet and the catalog through its start service; this keeps what's
// stored well-formed and every reference accounted for.
import { MAX_SETUP_KEYS, MAX_SETUP_STEPS } from '../constants-setups';
import { MAX_COLUMNS_PER_SHEET } from '../constants';
import { orderSteps } from './graph';
import { stepReads } from './refs';
import { KIND_LABEL, mainColumn, stepColumns, STEP_KINDS, type SetupSpec, type SetupStep } from './spec';
import { readStep } from './check-shape';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const names = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max
  && v.every(s => typeof s === 'string' && s.trim() !== '' && s.length <= 200);

export const stepLabel = (s: SetupStep): string => `${KIND_LABEL[s.kind]} "${mainColumn(s)}"`;

export function readSpec(raw: unknown): { ok: SetupSpec } | { problem: string } {
  if (!isObj(raw) || raw.v !== 1) return { problem: 'This isn\'t a setup Cubex can read.' };
  if (!names(raw.inputs, MAX_COLUMNS_PER_SHEET)) {
    return { problem: `Its inputs must be a list of at most ${MAX_COLUMNS_PER_SHEET} column names.` };
  }
  if (!names(raw.keys, MAX_SETUP_KEYS)) {
    return { problem: `Its saved keys must be a list of at most ${MAX_SETUP_KEYS} names.` };
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return { problem: 'It has no steps.' };
  if (raw.steps.length > MAX_SETUP_STEPS) return { problem: `A setup can have at most ${MAX_SETUP_STEPS} steps.` };
  const steps: SetupStep[] = [];
  for (const [i, s] of raw.steps.entries()) {
    if (!isObj(s) || !STEP_KINDS.includes(s.kind as never)) {
      return { problem: `Step ${i + 1} isn't a step Cubex knows.` };
    }
    const step = readStep(s);
    if ('problem' in step) return { problem: `Step ${i + 1}: ${step.problem}` };
    steps.push(step.ok);
  }
  if (steps.reduce((n, s) => n + stepColumns(s).length, 0) > MAX_COLUMNS_PER_SHEET) {
    return { problem: `Its steps make more than ${MAX_COLUMNS_PER_SHEET} columns, more than a sheet can hold.` };
  }
  const spec: SetupSpec = { v: 1, inputs: [...raw.inputs], keys: [...raw.keys], steps };
  const problem = specProblem(spec);
  return problem ? { problem } : { ok: spec };
}

// What's inconsistent in a setup, or null. The stored order must already be
// one where each step follows what it reads (saving writes it that way).
export function specProblem(spec: SetupSpec): string | null {
  const keys = new Set(spec.keys);
  const known = [...spec.inputs];
  const graph = [];
  for (const s of spec.steps) {
    const made = stepColumns(s);
    // Its own columns count as known so reading one is reported as a loop, not as "isn't a column".
    const reads = stepReads(s, [...known, ...made], keys);
    if (reads.problems.length) return `${stepLabel(s)}: ${reads.problems[0]}`;
    graph.push({ label: stepLabel(s), makes: made, reads: reads.columns });
    known.push(...made);
  }
  const ordered = orderSteps(graph);
  if ('problem' in ordered) return ordered.problem;
  if (ordered.ok.order.some((at, i) => at !== i)) return 'Its steps are out of order.';
  const extra = ordered.ok.inputs.find(c => !spec.inputs.includes(c));
  if (extra) return `It reads "${extra}" without listing it as an input.`;
  const lower = new Set<string>();
  for (const c of known) {
    if (lower.has(c.toLowerCase())) return `Two of its columns are named "${c}".`;
    lower.add(c.toLowerCase());
  }
  return null;
}
