// estimate_only for run_http_enrichment. PURE READ, like run-estimate.ts.
import { db } from '../lib/db';
import { targetRowsAndSample } from './run-estimate-rows';

export interface HttpEstimate {
  rows_to_process: number;
  ai_cost_usd: null;
  note: string;
}

// HTTP enrichment egresses from the user's own API, not an AI model — there is no
// AI dollar cost to price. Report the row count (= outbound calls before caching)
// and the operational caveats.
export function estimateHttpRun(
  userId: string, sheetId: string, targetRowIndexes: number[] | undefined,
): { fail: 'not_found' | 'no_rows'; message: string } | { ok: HttpEstimate } {
  const owns = db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, userId);
  if (!owns) return { fail: 'not_found', message: 'Sheet not found' };
  const { count } = targetRowsAndSample(sheetId, userId, targetRowIndexes);
  if (count === 0) return { fail: 'no_rows', message: 'No rows to process.' };
  return {
    ok: {
      rows_to_process: count,
      ai_cost_usd: null,
      note: 'HTTP enrichment runs against your own API (no AI credits). This is one outbound request per row before GET/HEAD caching, subject to your account outbound rate limit.',
    },
  };
}
