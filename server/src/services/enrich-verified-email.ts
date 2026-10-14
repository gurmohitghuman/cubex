// The "Verified work email" loop (plan sec. E): an optional free guess, then
// find, check, and find again with the providers already tried excluded,
// until an address passes the user's strategy. A repeat address skips its
// paid check; it stops after 2 repeats, 3 finds, or when the row's budget (the
// per-row cap, shared by every call) runs out. Ledger attempts g1, f1, v1, f2…
import { ENRICH_DUPLICATE_THRESHOLD, ENRICH_PROVIDER_RATE_RETRIES, ENRICH_VERIFY_MAX_FINDS } from '../lib/constants';
import { buildRequest, type BuiltRequest } from '../lib/enrich-request';
import { acceptedBy, classifyVerify, statusLabel, type EmailVerdict } from '../lib/enrich-email-status';
import { acceptedCell, guessEmail, guessParts, rejectedCell, VERDICT_RANK } from '../lib/enrich-email-guess';
import { ENRICH_CELL, type RowCells } from '../lib/enrich-cells';
import { displayName, verdictCells, waterfallOutcome, withCubex } from '../lib/enrich-outcome';
import { trimAnswer } from '../lib/answer-trim';
import type { EnrichRunConfig } from '../lib/enrich-run-config';
import { runStep, type RunCtx, type StepResult } from './enrich-step';
import type { EnrichRow, RowResult } from './enrich-row';

type Built = Extract<BuiltRequest, { ok: true }>;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
interface Judged {
  email: string; verdict: EmailVerdict; word: string | null; foundBy: string | null; checkedBy: string | null;
}

export async function verifiedEmailRow(
  ctx: RunCtx, config: EnrichRunConfig, row: EnrichRow, find: Built,
): Promise<RowResult | null> {
  const e = config.enrichment;
  const loop = e.email!;
  const budget = e.maxCostPerRowUsd === null ? null : Math.round(e.maxCostPerRowUsd * 1e6);
  let spent = 0, finds = 0, repeats = 0, budgetHit = false;
  let lastAnswer: unknown = null;
  let best: Judged | null = null;
  const judged = new Map<string, Judged>();
  const tried = new Set(e.route.exclude);
  const steps: Json[] = [];
  const left = () => (budget === null ? null : (budget - spent) / 1e6);
  const rateRetries = { left: ENRICH_PROVIDER_RATE_RETRIES };   // shared by the row's finds and checks

  const call = async (
    attempt: string, toolId: string, built: Built, routed: boolean, exclude: string[], prefer: string[],
    stopAtFirst: boolean,
  ): Promise<StepResult | null> => {
    const remaining = left();
    if (remaining !== null && remaining <= 0) { budgetHit = true; return null; }
    const parts = { method: built.method, path: built.path, query: built.query, body: built.body, prefer, exclude };
    const r = await runStep(ctx, {
      toolId, attempt, rowIndex: row.rowIndex, rowId: row.rowId, parts, rateRetries,
      request: { ...parts, routed, maxCostUsd: remaining, stopAtFirst, fresh: e.fresh },
    });
    spent += r.costMicro;
    if ((r.kind === 'row_skip' || r.kind === 'row_fail') && /per-row budget/i.test(r.message)) budgetHit = true;
    return r;
  };
  const check = async (attempt: string, email: string, foundBy: string | null): Promise<Judged | 'stop' | null> => {
    const built = buildRequest(loop.verifyTool, { email }, {}, { cleanDomains: false, columns: [] });
    if (!built.ok) return null;
    const r = await call(attempt, loop.verifyTool.id, built, loop.verifyKind === 'waterfall', loop.verifyExclude, [],
      false);
    if (!r) return null;
    if (r.kind !== 'answer') return r.kind === 'row_skip' || r.kind === 'row_fail' ? null : 'stop';
    const out = isObj(r.body) && isObj(r.body.output) ? r.body.output : null;
    const t = isObj(r.body) && isObj(r.body._treg) ? r.body._treg : {};
    const { verdict, word } = waterfallOutcome(r.body, r.meta) === 'hit'
      ? classifyVerify(out) : { verdict: 'no_verdict' as const, word: null };
    const checkedBy = displayName(e.providerNames, typeof t.served_by === 'string' ? t.served_by : r.meta.servedBy);
    const j: Judged = { email, verdict, word, foundBy, checkedBy };
    steps.push({ attempt, email, verdict, word, checked_by: j.checkedBy });
    judged.set(email.toLowerCase(), j);
    return j;
  };
  const done = (cells: RowCells): RowResult => ({ cells, stored: trimAnswer(cells.answer, true), costMicro: spent });
  const accept = (j: Judged): RowResult => done({
    status: 'completed', statusCell: acceptedCell(j.verdict), fill: 'all', reason: null,
    answer: withCubex(lastAnswer ?? {}, {
      email: j.email, email_status: statusLabel(j.verdict), found_by: j.foundBy, checked_by: j.checkedBy, steps,
    }),
  });
  const keep = (j: Judged) => { if (!best || VERDICT_RANK[j.verdict] > VERDICT_RANK[best.verdict]) best = j; };

  // 1. The free guess: only the check is paid (free with some checkers).
  const parts = loop.guess ? guessParts(find.sent) : null;
  const guess = parts ? guessEmail(loop.pattern, parts) : null;
  if (guess) {
    const j = await check('g1', guess, 'Pattern guess');
    if (j === 'stop') return null;
    if (j && acceptedBy(loop.strategy, j.verdict)) return accept(j);
    if (j) keep(j);
  }
  // 2. Find, check, find again without the providers already tried.
  while (finds < ENRICH_VERIFY_MAX_FINDS && !budgetHit) {
    finds++;
    const exclude = [...tried].sort();
    const prefer = e.route.prefer.filter(p => !tried.has(p));
    const r = await call(`f${finds}`, e.toolId, find, true, exclude, prefer, e.route.stopAtFirst);
    if (!r) break;
    if (r.kind === 'pause' || r.kind === 'fail_run' || r.kind === 'stopped') return null;
    if (r.kind !== 'answer') {
      if (!best && !budgetHit) return { cells: verdictCells(r.kind, r.message), stored: undefined, costMicro: spent };
      break;
    }
    lastAnswer = r.body;
    const t = isObj(r.body) && isObj(r.body._treg) ? r.body._treg : {};
    for (const step of Array.isArray(t.tried) ? t.tried.filter(isObj) : []) {
      if (typeof step.provider === 'string' && step.outcome !== 'skipped') tried.add(step.provider.toLowerCase());
    }
    const outcome = waterfallOutcome(r.body, r.meta);
    const out = isObj(r.body) && isObj(r.body.output) ? r.body.output : {};
    const email = typeof out.email === 'string' && out.email.includes('@') ? out.email.trim() : null;
    // An address already checked in this row skips its paid check; the note says so.
    const seen = outcome === 'hit' && email && out.verified !== true ? judged.get(email.toLowerCase()) : undefined;
    steps.push({ attempt: `f${finds}`, email, outcome, ...(seen ? { already_checked: seen.verdict } : {}) });
    if (outcome === 'capped') budgetHit = true;
    if (outcome !== 'hit' || !email) break;
    const foundBy = displayName(e.providerNames, typeof t.served_by === 'string' ? t.served_by : r.meta.servedBy);
    if (out.verified === true) return accept({ email, verdict: 'valid', word: null, foundBy, checkedBy: foundBy });
    if (seen) {
      if (++repeats >= ENRICH_DUPLICATE_THRESHOLD) break;
      continue;
    }
    const j = await check(`v${finds}`, email, foundBy);
    if (j === 'stop') return null;
    if (j && acceptedBy(loop.strategy, j.verdict)) return accept(j);
    if (j) keep(j);
  }
  const b = best as Judged | null;
  if (b) {
    return done({
      status: 'completed', statusCell: rejectedCell(b.verdict), fill: 'cubex', reason: null,
      answer: withCubex(lastAnswer ?? {}, {
        email_status: statusLabel(b.verdict), checked_by: b.checkedBy, rejected_email: b.email, steps,
      }),
    });
  }
  const answer = withCubex(lastAnswer ?? {}, { steps });
  return done(budgetHit
    ? {
      status: 'completed', statusCell: ENRICH_CELL.budget, answer, fill: 'none', reason: 'The row reached its budget.',
    }
    : { status: 'completed', statusCell: ENRICH_CELL.notFound, answer, fill: 'none', reason: null });
}
