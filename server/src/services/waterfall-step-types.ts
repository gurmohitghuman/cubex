// What one waterfall step did for one row (services/waterfall-step-*.ts), as
// the row engine (waterfall-row.ts) reads it. A step that ran returns a
// StepRun; one that met a run-level stop (treg refused the key, the run was
// paused, an AI key problem) returns STOP and the row writes nothing: it keeps
// its ⏳ and the resume picks it up.
import type { StepFrom, StepOutcome } from '../lib/waterfall/trace';

export interface StepRun {
  outcome: Exclude<StepOutcome, 'rejected'>;
  value: string;              // the answer, as the result type reads it ('' if none)
  got?: string;               // what came back that wasn't an answer (shown in the trace)
  detail?: string;
  provider?: string;
  costUsd: number;            // what this call cost (0 when replayed or reused): treg's charge, OpenRouter's
  aiProviderUsd?: number;     // an AI step on the user's own provider key: what that provider billed
  from?: StepFrom;
  // An enrichment step's treg answer and its lookup key, kept on the row so a
  // later run can reuse a found answer (lib/enrich-reuse-key.ts). Real calls only.
  body?: unknown;
  reuseKey?: string;
  routed?: boolean;
}

export const STOP = Symbol('waterfall-step-stop');
export type StepResult = StepRun | typeof STOP;

export const noInputs = (detail: string): StepRun => ({ outcome: 'no_inputs', value: '', detail, costUsd: 0 });
