// What the agent surfaces (MCP and /api/v1) say about enrichments in the same
// words: the daily limit for all enrichments, and what the status cells mean,
// so an agent never reads "⏭️ Not found" as a value.
import { dailyLimitView, type DailyLimitView } from './treg-key';

export interface DailyLimitJson { limit_usd: number | null; used_today_usd: number; remaining_usd: number | null }

export const dailyLimitJson = (v: DailyLimitView): DailyLimitJson =>
  ({ limit_usd: v.limitUsd, used_today_usd: v.usedTodayUsd, remaining_usd: v.remainingUsd });

export const dailyLimitOf = (userId: string): DailyLimitJson => dailyLimitJson(dailyLimitView(userId));

export const DAILY_LIMIT_NOTE =
  'The account\'s daily_limit caps ALL enrichments per UTC day (limit_usd null: off): a run that reaches it '
  + 'pauses; tell the user, who can raise it in Settings (a token can\'t).';

// The status column's words, and what the output columns hold next to them.
export const STATUS_WORDS =
  'Status cells are Cubex\'s own words, never data: "✅ Found", "⏭️ Not found", "⏭️ Budget ran out" (the '
  + 'per-row cap), other "⏭️ ..." (skipped) or "❌ ..." (failed) with the reason, "⏳ Processing...", '
  + '"⏭️ Condition not met" (run_if kept the row out, no cost). Verified email: "✅ Valid", "✅ Catch-all", '
  + '"✅ Risky"; a rejected row fills Email status, never Email. Row-adding jobs: "➕ ..." while adding, '
  + 'waiting for fields or room, or removing a rerun\'s earlier rows, "✅ N rows added", "✅ Already there", '
  + '"✅ No rows to add", "❌ Rows not added: <reason>". An empty status cell means the row hasn\'t run (rows '
  + 'missing an input stay empty).';
