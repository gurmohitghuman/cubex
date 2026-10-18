// estimate_only for run_http_enrichment. PURE READ, like run-estimate.ts.
import { verifySheetOwnership } from '../lib/sql-helpers';
import { ruleRowsAndSample, targetRowsAndSample } from './run-estimate-rows';
import { checkRunRule } from './run-rule';

export interface HttpEstimate {
  rows_to_process: number;
  // With an "Only run if" rule: the rule as stored and the rows it keeps out.
  run_if?: string;
  rows_skipped_by_rule?: number;
  ai_cost_usd: null;
  note: string;
}

// HTTP enrichment egresses from the user's own API, not an AI model — there is no
// AI dollar cost to price. Report the row count (= outbound calls before caching)
// and the operational caveats.
export async function estimateHttpRun(
  userId: string, sheetId: string, targetRowIndexes: number[] | undefined, runIf?: string | null,
): Promise<{ fail: 'not_found' | 'no_rows' | 'bad_request'; message: string } | { ok: HttpEstimate }> {
  const owns = verifySheetOwnership(sheetId, userId);
  if (!owns) return { fail: 'not_found', message: 'Sheet not found' };
  const rule = checkRunRule(sheetId, userId, runIf);
  if ('error' in rule) return { fail: 'bad_request', message: rule.error };
  const { count, skipped } = rule.ok
    ? await ruleRowsAndSample(sheetId, userId, rule.ok, targetRowIndexes)
    : { ...targetRowsAndSample(sheetId, userId, targetRowIndexes), skipped: 0 };
  if (count === 0) {
    return { fail: 'no_rows', message: rule.ok ? 'No rows pass the "Only run if" rule.' : 'No rows to process.' };
  }
  return {
    ok: {
      rows_to_process: count,
      ...(rule.ok ? { run_if: rule.ok.rule, rows_skipped_by_rule: skipped } : {}),
      ai_cost_usd: null,
      note: 'HTTP enrichment runs against your own API (no AI credits). This is one outbound request per row before GET/HEAD caching, subject to your account outbound rate limit.',
    },
  };
}
