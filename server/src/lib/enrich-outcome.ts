// What a treg answer means for one row's cells (pure). A waterfall found
// something only when _treg.outcome is hit or weak: a stop-at-first miss still
// names the provider it asked (served_by), so "Found by" and every output are
// gated on the outcome, never on served_by (M0). A capped waterfall that found
// nothing ran out of the row's budget, which is not the same as "not found".
import { ENRICH_CELL, enrichCellValues, failedCell, type RowCells } from './enrich-cells';
import { providerOf, type TregMeta } from './treg-meta';
import type { ResponseMapping } from './http-request-template';
import { itemsOf, type EnrichListConfig } from './enrich-list';
import type { ReusedFrom } from './enrich-reuse-key';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export function displayName(providerNames: Record<string, string>, endpointOrSlug: string | null): string | null {
  const slug = providerOf(endpointOrSlug);
  return slug ? providerNames[slug.toLowerCase()] ?? slug : null;
}

export function waterfallOutcome(body: unknown, meta: TregMeta): 'hit' | 'miss' | 'capped' {
  const t = isObj(body) && isObj(body._treg) ? body._treg : {};
  const outcome = typeof t.outcome === 'string' ? t.outcome.toLowerCase() : meta.routeOutcome;
  if (outcome === 'hit' || outcome === 'weak') return 'hit';
  return meta.routeCapped ? 'capped' : 'miss';
}

// A copied answer's notes: the row of this run it came from, or the earlier
// run's answer it reuses (services/enrich-reuse.ts).
function sharedNotes(sameAsRow: number | null, reusedFrom?: ReusedFrom | null): Json {
  return {
    ...(sameAsRow !== null ? { same_as_row_index: sameAsRow } : {}),
    ...(reusedFrom ? { reused_from: reusedFrom } : {}),
  };
}

// The answer outputs read: treg's body plus what Cubex adds under _cubex.
export function withCubex(body: unknown, extra: Json): unknown {
  return isObj(body) ? { ...body, _cubex: { ...(isObj(body._cubex) ? body._cubex : {}), ...extra } } : body;
}

export function answerCells(a: {
  routed: boolean; body: unknown; meta: TregMeta; providerNames: Record<string, string>;
  mapping: ResponseMapping[]; sameAsRow: number | null; reusedFrom?: ReusedFrom | null;
}): RowCells {
  const shared = sharedNotes(a.sameAsRow, a.reusedFrom);
  if (a.routed) {
    const outcome = waterfallOutcome(a.body, a.meta);
    const t = isObj(a.body) && isObj(a.body._treg) ? a.body._treg : {};
    const servedBy = typeof t.served_by === 'string' ? t.served_by : a.meta.servedBy;
    const found = outcome === 'hit';
    const answer = withCubex(a.body, {
      ...shared, outcome, ...(found ? { found_by: displayName(a.providerNames, servedBy) } : {}),
    });
    if (found) return { status: 'completed', statusCell: ENRICH_CELL.found, answer, fill: 'all', reason: null };
    return outcome === 'capped'
      ? {
        status: 'completed', statusCell: ENRICH_CELL.budget, answer, fill: 'none',
        reason: 'Every provider the budget allowed missed; the rest were skipped.',
      }
      : { status: 'completed', statusCell: ENRICH_CELL.notFound, answer, fill: 'none', reason: null };
  }
  // A single tool found something when any picked output has a value.
  const answer = withCubex(a.body, shared);
  const probe: RowCells = { status: 'completed', statusCell: '', answer, fill: 'all', reason: null };
  const values = Object.values(enrichCellValues(probe, a.mapping, null));
  const found = a.mapping.length === 0 || values.some(v => v !== '');
  return found
    ? { ...probe, statusCell: ENRICH_CELL.found }
    : { status: 'completed', statusCell: ENRICH_CELL.notFound, answer, fill: 'none', reason: null };
}

// A row the classifier skipped or failed (no usable answer).
export function verdictCells(kind: 'row_skip' | 'row_fail', message: string): RowCells {
  if (kind === 'row_fail') {
    return { status: 'failed', statusCell: failedCell(message), answer: null, fill: 'none', reason: message };
  }
  const budget = /per-row budget/i.test(message);
  return {
    status: 'completed', statusCell: budget ? ENRICH_CELL.budget : `⏭️ ${message}`, answer: null, fill: 'none',
    reason: message,
  };
}

// A row without the inputs this run needs: nothing written but empty cells, so
// it reads as "not run yet" and a later run picks it up.
export function missingCells(missing: string): RowCells {
  return { status: 'completed', statusCell: '', answer: null, fill: 'none', reason: `Missing inputs: ${missing}` };
}

// A list job's answer: its results (at most maxItems), and the row's cells
// while they wait to become rows. The status cell of a row with results is
// written with the journal row (services/enrich-row-write.ts).
export function listAnswerCells(a: {
  routed: boolean; body: unknown; meta: TregMeta; providerNames: Record<string, string>;
  list: EnrichListConfig; sameAsRow: number | null; reusedFrom?: ReusedFrom | null;
}): { cells: RowCells; items: unknown[] } {
  const shared = sharedNotes(a.sameAsRow, a.reusedFrom);
  const outcome = a.routed ? waterfallOutcome(a.body, a.meta) : 'hit';
  const items = outcome === 'hit' ? itemsOf(a.body, a.list.itemsPath, a.list.maxItems) : [];
  const t = isObj(a.body) && isObj(a.body._treg) ? a.body._treg : {};
  const servedBy = typeof t.served_by === 'string' ? t.served_by : a.meta.servedBy;
  const answer = withCubex(a.body, {
    ...shared, ...(a.routed ? { outcome } : {}),
    ...(a.routed && items.length ? { found_by: displayName(a.providerNames, servedBy) } : {}),
  });
  if (outcome === 'capped') {
    const reason = 'Every provider the budget allowed missed; the rest were skipped.';
    return { cells: { status: 'completed', statusCell: ENRICH_CELL.budget, answer, fill: 'none', reason }, items };
  }
  const statusCell = items.length ? '' : ENRICH_CELL.notFound;
  return { cells: { status: 'completed', statusCell, answer, fill: 'none', reason: null }, items };
}
