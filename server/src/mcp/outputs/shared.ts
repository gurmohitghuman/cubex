// Pieces several tools' answers share (mcp/output-schema.ts says how they are published).
import { z } from 'zod';
import { keyed, obj } from '../output-schema';

export const str = z.string();
export const num = z.number();
export const bool = z.boolean();
export const strs = z.array(z.string());
export const opt = <T extends z.ZodType>(t: T) => t.optional();
export const nul = <T extends z.ZodType>(t: T) => t.nullable();

// Fields that depend on the case, described where the tool's description explains them.
export const info = (what: string) => keyed(z.unknown()).describe(what);

// A cell as a read answers it: text, a number or true/false, null, or with include_status
// {status, value, error}.
export const cells = keyed(z.unknown()).describe('Column name -> cell value');

// Where a delete went (services/trash-answer.ts).
export const trash = obj({
  trash_id: nul(num).describe('For restore_from_trash; null when Settings keeps deleted items 0 days'),
  kept_days: opt(num), restorable_until: opt(str), how_to_restore: opt(str),
  state: opt(z.enum(['kept', 'moving'])), note: opt(str),
});

// Auto-run columns that will fill rows a write added (services/enrich-agent-autorun.ts).
export const autoRunNotice = z.array(obj({
  column: str, kind: str, rows: num, sends_requests: bool,
  estimated_usd: nul(obj({ low: num, high: num })), daily_cap_usd: nul(num), daily_row_cap: nul(num),
  paused: nul(str), note: opt(str),
})).describe('Auto-run columns that will fill the new rows, and what they may cost');

export const autoDedupe = info('What auto-dedupe did not keep or replaced (set_auto_dedupe)');

// The versions a write or read answers, to echo on the next call.
export const versions = { data_version: num, row_generation: num };

// What a write changed, one item per sheet it touched (mcp/changed.ts); [] when this call changed nothing (a
// preview, a dry run, an estimate, a replay).
export const CHANGED_ROW_IDS = 100;
// Described once, briefly: about 33 tools carry it in tools/list (docs/mcp.md, "What a write changed", says
// the rest).
export const changed = z.array(obj({
  sheet_id: str, sheet: str, columns: strs, rows: num, row_ids: opt(strs), ...versions,
  more_coming: opt(z.literal(true)),
})).describe(`Each sheet written: columns and rows touched, the first ${CHANGED_ROW_IDS} row_ids, versions after; `
  + 'more_coming: work goes on');
