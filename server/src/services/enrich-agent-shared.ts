// What the agent surfaces (MCP and /api/v1) say about enrichments in the same
// words: the daily limit for all enrichments, and what the status cells mean,
// so an agent never reads "⏭️ Not found" as a value.
import { dailyLimitView, type DailyLimitView } from './treg-key';

export interface DailyLimitJson { limit_usd: number | null; used_today_usd: number; remaining_usd: number | null }

export const dailyLimitJson = (v: DailyLimitView): DailyLimitJson =>
  ({ limit_usd: v.limitUsd, used_today_usd: v.usedTodayUsd, remaining_usd: v.remainingUsd });

export const dailyLimitOf = (userId: string): DailyLimitJson => dailyLimitJson(dailyLimitView(userId));

export const DAILY_LIMIT_NOTE =
  'daily_limit {limit_usd, used_today_usd, remaining_usd} is the account\'s limit for ALL enrichments per UTC day '
  + '(limit_usd null: off). A run that reaches it pauses; tell the user, who can raise it in Settings '
  + '(a token can\'t).';

// The status column's words, and what the output columns hold next to them.
export const STATUS_WORDS =
  'Status cells are Cubex\'s own words, never data: "✅ Found" (outputs filled), "⏭️ Not found", '
  + '"⏭️ Budget ran out" (the per-row cap stopped the waterfall before a provider found it), any other '
  + '"⏭️ ..." (skipped, with the reason), "❌ ..." (failed, with the reason), '
  + '"⏳ Processing..." (still running). '
  + 'Verified work email: "✅ Valid", "✅ Catch-all", "✅ Risky"; a row it rejected '
  + '("⏭️ Only a catch-all address (not accepted)"...) still fills Email status and Checked by, never Email. '
  + 'Jobs that add rows to another sheet: '
  + '"➕ Adding N rows…", "➕ N results, waiting for fields", "➕ N rows waiting for room in <sheet>", '
  + '"✅ N rows added" (", M already there" when duplicates were skipped), "✅ Already there", '
  + '"❌ Rows not added: <reason>". Output columns are empty on rows that found nothing; a column added from '
  + 'stored answers says "⏭️ No data" where the answer had no value. An empty status cell means the row hasn\'t '
  + 'run (rows missing an input are skipped and stay empty).';
