// An enrichment step of a waterfall row: one treg tool, called exactly as an
// enrichment column calls it (services/enrich-step.ts runStep: the ledger
// first, never an aborted call, the Idempotency-Key a resume replays free),
// with its own attempt name per step so two steps never share a key. Before
// calling, a found answer to the same lookup that any run stored in the last
// N days is reused at $0 (services/enrich-reuse.ts), and a single tool asks
// treg for an answer it already paid for (services/enrich-recover.ts).
import { buildRequest, idempotencyKey, type BuiltRequest } from '../lib/enrich-request';
import { readTregMeta, type TregMeta } from '../lib/treg-meta';
import { displayName, waterfallOutcome } from '../lib/enrich-outcome';
import { extractOutcome } from '../lib/jsonpath-extract';
import { freshBody, reuseKeyOf, rowParts, wholeFor } from '../lib/enrich-reuse-key';
import { normalizeResult } from '../lib/waterfall/result-type';
import { toolTemplates } from '../lib/waterfall/rows';
import { traceDetail, traceValue } from '../lib/waterfall/trace';
import type { BuiltEnrichment, EnrichmentChoices, WaterfallBlock } from '../lib/waterfall/config';
import type { EnrichRunConfig } from '../lib/enrich-run-config';
import { keyScope, runStep, type RunCtx } from './enrich-step';
import { recoverPaidAnswer } from './enrich-recover';
import { recordCall } from './enrich-ledger';
import { findReusable, reuseSince } from './enrich-reuse';
import { noInputs, STOP, type StepResult, type StepRun } from './waterfall-step-types';

type Built = Extract<BuiltRequest, { ok: true }>;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const REUSED_META: TregMeta = { ...readTregMeta({}), costMicro: 0 };

export interface EnrichStepArgs {
  ctx: RunCtx;
  w: WaterfallBlock;
  stepId: string;
  choices: EnrichmentChoices;
  built: BuiltEnrichment;
  row: { rowIndex: number; rowId: string | null };
  inputs: Record<string, string>;     // the waterfall's input values for the row
  fresh: boolean;                     // never reuse an earlier answer
}

// The step as an enrichment config, for the reuse key (the tool, its route and
// the request decide treg's answer; an enrichment column with the same lookup
// shares the key).
function asEnrichConfig(b: BuiltEnrichment, toolId: string): EnrichRunConfig {
  return { enrichment: { toolId, kind: b.toolKind, route: b.route, email: null } } as unknown as EnrichRunConfig;
}

// The step's request for the row, or why there is none.
export function stepRequest(a: Pick<EnrichStepArgs, 'choices' | 'built' | 'inputs'>): { built: Built } | StepRun {
  const req = buildRequest(a.built.toolSnapshot, toolTemplates(a.choices), a.inputs,
    { cleanDomains: a.built.cleanDomains, columns: Object.keys(a.inputs) });
  if (req.ok) return { built: req };
  if ('missing' in req) return noInputs(`Missing inputs: ${req.missing}`);
  return { outcome: 'error', value: '', detail: traceDetail(req.invalid), costUsd: 0 };
}

// An answer as the step's outcome: a treg waterfall found something only on a
// hit (a capped miss ran out of budget); a single tool when its value path holds one.
function readAnswer(a: EnrichStepArgs, body: unknown, meta: TregMeta, costMicro: number): StepRun {
  const costUsd = costMicro / 1e6;
  const b = a.built;
  const routed = b.toolKind === 'waterfall';
  const outcome = routed ? waterfallOutcome(body, meta) : 'hit';
  if (outcome === 'capped') {
    return { outcome: 'budget', value: '', costUsd, detail: 'The step reached its cost cap.' };
  }
  const got = outcome === 'hit' ? extractOutcome(body, b.valuePath) : null;
  const raw = got?.matched && !got.error ? got.value : null;
  const value = normalizeResult(a.w.resultType, raw, a.w.phone);
  const t = isObj(body) && isObj(body._treg) ? body._treg : {};
  const served = typeof t.served_by === 'string' ? t.served_by : meta.servedBy;
  const provider = routed && outcome === 'hit' ? displayName(b.providerNames, served) ?? undefined : undefined;
  if (value) return { outcome: 'answered', value, costUsd, provider, body, routed };
  const shown = typeof raw === 'string' || typeof raw === 'number' ? traceValue(String(raw)) : undefined;
  return { outcome: 'not_found', value: '', costUsd, ...(shown ? { got: shown } : {}), body, routed };
}

function reused(a: EnrichStepArgs, built: Built): StepRun | null {
  const since = a.fresh ? null : reuseSince(a.ctx.reuseDays ?? 0);
  if (!since) return null;
  const key = reuseKeyOf(asEnrichConfig(a.built, a.choices.toolId), built);
  const found = findReusable(a.ctx.userId, key, since, a.ctx.runId);
  if (!found || !wholeFor([a.built.valuePath], found.notes)) return null;
  const r = readAnswer(a, freshBody(found.body), REUSED_META, 0);
  // Reused, not bought: nothing to key again.
  return { ...r, from: 'reused', body: undefined };
}

export async function enrichmentStep(a: EnrichStepArgs): Promise<StepResult> {
  const req = stepRequest(a);
  if (!('built' in req)) return req;
  const reuse = reused(a, req.built);
  if (reuse) return reuse;
  const { ctx, built: b, row } = a;
  const routed = b.toolKind === 'waterfall';
  const parts = rowParts(asEnrichConfig(b, a.choices.toolId), req.built);
  const reuseKey = reuseKeyOf(asEnrichConfig(b, a.choices.toolId), req.built);
  const attempt = `w${a.stepId}.t1`;
  if (!routed) {
    const recovered = await recoverPaidAnswer(ctx, row.rowId, row.rowIndex, a.choices.toolId, parts);
    if (recovered) {
      // A free replay: the first charge is in the ledger already.
      const meta = { ...readTregMeta({}), callId: recovered.callId, costMicro: 0, replay: true };
      const at = keyScope(ctx, row.rowIndex, row.rowId);
      recordCall({
        userId: ctx.userId, sheetId: ctx.sheetId, runId: ctx.runId, rowId: row.rowId, statusColumn: ctx.statusColumn,
        toolId: a.choices.toolId, attempt, idempotencyKey: idempotencyKey(at.scope, at.row, attempt, parts),
        httpStatus: 200, tregErrorCode: null, tier: null, meta,
      });
      // Its cost is this step's only when this step bought it (not another step's same request).
      const cost = recovered.attempt === attempt ? recovered.costMicro : 0;
      return { ...readAnswer(a, recovered.body, meta, cost), reuseKey };
    }
  }
  const r = await runStep(ctx, {
    toolId: a.choices.toolId, attempt, rowIndex: row.rowIndex, rowId: row.rowId, parts, sameKey: a.stepId,
    request: { ...parts, routed, maxCostUsd: b.capUsd, stopAtFirst: b.route.stopAtFirst, fresh: a.fresh },
  });
  if (r.kind === 'answer') {
    if (r.oversize) {
      return { outcome: 'error', value: '', detail: "The answer was too big to read (over treg's 8 MB limit).",
        costUsd: r.costMicro / 1e6 };
    }
    const read = readAnswer(a, r.body, r.meta, r.costMicro);
    // Another row of this run asked the same lookup first: its answer, at $0.
    if (r.sameAsRow !== null) return { ...read, from: 'same_lookup', body: undefined };
    return { ...read, reuseKey };
  }
  if (r.kind === 'row_skip') {
    const budget = /per-row budget/i.test(r.message);
    const outcome = budget ? 'budget' : 'not_found';
    return { outcome, value: '', detail: traceDetail(r.message), costUsd: r.costMicro / 1e6 };
  }
  if (r.kind === 'row_fail') {
    return { outcome: 'error', value: '', detail: traceDetail(r.message), costUsd: r.costMicro / 1e6 };
  }
  // pause, fail_run (ctx.halt is set) or stopped: the row ends without writing.
  return STOP;
}
