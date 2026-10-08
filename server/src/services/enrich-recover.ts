// Recover before re-buying (plan sec. 5): when an earlier run paid for this
// row's exact request but its answer never reached the sheet (cancelled in
// flight, a crash between answer and write), a rerun first asks treg for the
// stored answer (GET /calls/{id}/result, free). Only metered single-tool calls
// are kept by treg (waterfalls answer stored:false), so only those try.
import { db } from '../lib/db';
import { tregGetJson } from '../lib/treg';
import { requestFingerprint, type KeyParts } from '../lib/enrich-request';
import type { RunCtx } from './enrich-step';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export interface Recovered { body: unknown; callId: string }

export async function recoverPaidAnswer(
  ctx: RunCtx, rowId: string | null, rowIndex: number, toolId: string, parts: KeyParts,
): Promise<Recovered | null> {
  if (!rowId) return null;
  const fp = requestFingerprint(parts).slice(0, 32);
  // The newest paid call for this row and request in another run whose result
  // that run never wrote. The key ends with the request's fingerprint.
  const prior = db.prepare(`
    SELECT c.call_id AS callId FROM enrichment_calls c
    WHERE c.user_id = ? AND c.row_id = ? AND c.tool_id = ? AND c.idempotency_key LIKE ? AND c.run_id IS NOT NULL AND c.run_id <> ?
      AND c.cost_micro > 0 AND c.call_id IS NOT NULL AND c.http_status BETWEEN 200 AND 299
      AND NOT EXISTS (SELECT 1 FROM http_results r WHERE r.run_id = c.run_id AND r.row_index = ?)
    ORDER BY c.created_at DESC LIMIT 1
  `).get(ctx.userId, rowId, toolId, `%:${fp}`, ctx.runId, rowIndex) as { callId: string } | undefined;
  if (!prior) return null;
  try {
    const res = await tregGetJson<Json>(`/calls/${encodeURIComponent(prior.callId)}/result`, ctx.token);
    const b = res.body;
    if (res.status !== 200 || !b || b.stored !== true) return null;
    const code = typeof b.status_code === 'number' ? b.status_code : 0;
    if (code < 200 || code > 299 || !(isObj(b.response) || Array.isArray(b.response))) return null;
    return { body: b.response, callId: prior.callId };
  } catch { return null; }
}
