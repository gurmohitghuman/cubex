// One enrichment row: build treg's request from the row's cells, call it (one
// step, or the Verified work email loop), then write the result. A row whose
// run was stopped meanwhile (paused, cancelled, a limit, an unreachable treg)
// writes nothing and keeps its ⏳, so the resume picks it up and re-sends the
// same Idempotency-Key: treg replays a paid answer for free.
import { buildRequest, idempotencyKey, type BuiltRequest } from '../lib/enrich-request';
import { readTregMeta } from '../lib/treg-meta';
import { inputTemplates, type EnrichRunConfig } from '../lib/enrich-run-config';
import { answerCells, listAnswerCells, missingCells, verdictCells } from '../lib/enrich-outcome';
import { copyValues } from '../lib/enrich-list';
import type { TregMeta } from '../lib/treg-meta';
import { failedCell, type RowCells } from '../lib/enrich-cells';
import { trimAnswer } from '../lib/answer-trim';
import { keyScope, runStep, type RunCtx, type StepResult } from './enrich-step';
import { verifiedEmailRow } from './enrich-verified-email';
import { recoverPaidAnswer } from './enrich-recover';
import { recordCall } from './enrich-ledger';
import { writeEnrichmentResult } from './enrich-row-write';
import type { HTTPRunRow } from './http-runner-status';

export interface EnrichRow { rowIndex: number; rowId: string | null; data: Record<string, string> }

// What a row produced: cells to write, or nothing (the run stopped). A list
// job's results (items) are journaled with them, to become rows elsewhere.
export interface RowResult { cells: RowCells; stored: unknown; costMicro: number; items?: unknown[] }

// An answer as the row's cells: outputs, or a list job's results.
function answered(
  config: EnrichRunConfig, routed: boolean, body: unknown, meta: TregMeta, sameAsRow: number | null,
  costMicro: number,
): RowResult {
  const e = config.enrichment;
  if (e.list) {
    const { cells, items } = listAnswerCells({
      routed, body, meta, providerNames: e.providerNames, list: e.list, sameAsRow,
    });
    return { cells, stored: trimAnswer(cells.answer, routed), costMicro, items };
  }
  const cells = answerCells({
    routed, body, meta, providerNames: e.providerNames, mapping: config.responseMapping, sameAsRow,
  });
  return { cells, stored: trimAnswer(cells.answer, routed), costMicro };
}

type Built = Extract<BuiltRequest, { ok: true }>;

// The request a row sends, or the cells for a row that can't send one.
export function rowRequest(
  config: EnrichRunConfig, row: EnrichRow, columns: string[],
): { built: Built } | { cells: RowCells } {
  const e = config.enrichment;
  const built = buildRequest(e.toolSnapshot, inputTemplates(config), row.data,
    { cleanDomains: e.cleanDomains, columns });
  if (built.ok) return { built };
  if ('missing' in built) return { cells: missingCells(built.missing) };
  const reason = built.invalid;
  return { cells: { status: 'failed', statusCell: failedCell(reason), answer: null, fill: 'none', reason } };
}

// One call for the run's tool, read into cells.
async function singleStep(
  ctx: RunCtx, config: EnrichRunConfig, row: EnrichRow, built: Built,
): Promise<RowResult | null> {
  const e = config.enrichment;
  const routed = e.kind === 'waterfall';
  const route = routed ? e.route : { prefer: [], exclude: [], stopAtFirst: false };
  const parts = {
    method: built.method, path: built.path, query: built.query, body: built.body,
    prefer: route.prefer, exclude: route.exclude,
  };
  if (!routed) {
    const recovered = await recoverPaidAnswer(ctx, row.rowId, row.rowIndex, e.toolId, parts);
    if (recovered) {
      // Recorded as a free replay: the first charge is already in the ledger
      // (and in this run's spend when this run paid it), so nothing moves.
      const meta = { ...readTregMeta({}), callId: recovered.callId, costMicro: 0, replay: true };
      const at = keyScope(ctx, row.rowIndex, row.rowId);
      recordCall({
        userId: ctx.userId, sheetId: ctx.sheetId, runId: ctx.runId, rowId: row.rowId,
        statusColumn: ctx.statusColumn, toolId: e.toolId,
        attempt: 't1', idempotencyKey: idempotencyKey(at.scope, at.row, 't1', parts), httpStatus: 200,
        tregErrorCode: null, tier: null, meta,
      });
      return answered(config, routed, recovered.body, meta, null, recovered.costMicro);
    }
  }
  const r: StepResult = await runStep(ctx, {
    toolId: e.toolId, attempt: 't1', rowIndex: row.rowIndex, rowId: row.rowId, parts,
    request: { ...parts, routed, maxCostUsd: e.maxCostPerRowUsd, stopAtFirst: route.stopAtFirst, fresh: e.fresh },
  });
  if (r.kind === 'answer') {
    if (r.oversize) {
      const cells = verdictCells('row_fail', "The answer was too big to read (over treg's 8 MB limit).");
      return { cells, stored: undefined, costMicro: r.costMicro };
    }
    return answered(config, routed, r.body, r.meta, r.sameAsRow, r.costMicro);
  }
  if (r.kind === 'row_skip' || r.kind === 'row_fail') {
    return { cells: verdictCells(r.kind, r.message), stored: undefined, costMicro: r.costMicro };
  }
  return null;
}

export async function processEnrichmentRow(
  ctx: RunCtx, run: HTTPRunRow, config: EnrichRunConfig, row: EnrichRow, columns: string[], generation: number,
): Promise<void> {
  const req = rowRequest(config, row, columns);
  let result: RowResult | null;
  if ('cells' in req) result = { cells: req.cells, stored: undefined, costMicro: 0 };
  else if (config.enrichment.email) result = await verifiedEmailRow(ctx, config, row, req.built);
  else result = await singleStep(ctx, config, row, req.built);
  if (!result) return;
  const request = 'built' in req
    ? {
      toolId: config.enrichment.toolId, method: req.built.method, path: req.built.path, query: req.built.query,
      body: req.built.body,
    }
    : { toolId: config.enrichment.toolId };
  const list = config.enrichment.list;
  writeEnrichmentResult({
    run, generation, rowIndex: row.rowIndex, cells: result.cells, stored: result.stored,
    mapping: config.responseMapping, costMicro: result.costMicro, request,
    ...(list && result.items?.length
      ? { list: { items: result.items, copy: copyValues(list, row.data), rowId: row.rowId } } : {}),
  });
}
