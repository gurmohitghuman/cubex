// Reading a sheet's change log (migration 037; written by lib/change-log.ts):
// the app's History panel, GET /api/v1/sheets/:id/history and MCP
// get_sheet_history. Newest first, a page at a time by id. Kept
// CHANGE_LOG_DAYS days: the trash sweep prunes older lines in slices.
import { db } from '../lib/db';
import {
  CHANGE_LOG_DAYS, CHANGE_LOG_PAGE_DEFAULT, CHANGE_LOG_PAGE_MAX, CHANGE_LOG_PRUNE_SLICE,
} from '../lib/constants';
import { yieldToRequests } from '../lib/slices';
import { actorLabel, type Via } from '../lib/actor';

export interface SheetChange {
  id: number;
  at: string;                 // ISO time, UTC
  via: Via;
  token_name: string | null;
  by: string;                 // "the app", "the token "Agent" (MCP)", "Cubex"
  action: string;
  column: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
  // A line about something in the trash: whether it is still there to restore.
  in_trash?: boolean;
}

export interface HistoryPage { changes: SheetChange[]; next_before: number | null; kept_days: number }

interface ChangeRow {
  id: number; at: string; via: Via; token_name: string | null; action: string;
  column_name: string | null; summary: string; detail: string | null;
}

const isoAt = (at: string): string => `${at.replace(' ', 'T')}Z`;

// `before`: the id of the last line already read (a page goes on below it).
// `column`: only lines about that column.
export function readSheetHistory(
  sheetId: string, userId: string, opts: { before?: number; limit?: number; column?: string } = {},
): HistoryPage {
  const limit = Math.max(1, Math.min(CHANGE_LOG_PAGE_MAX, opts.limit ?? CHANGE_LOG_PAGE_DEFAULT));
  const rows = db.prepare(`SELECT id, at, via, token_name, action, column_name, summary, detail FROM sheet_changes
    WHERE sheet_id = ? AND user_id = ? AND id < ? AND (? IS NULL OR column_name = ?)
    ORDER BY id DESC LIMIT ?`)
    .all(sheetId, userId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.column ?? null, opts.column ?? null,
      limit + 1) as ChangeRow[];
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const live = trashStillThere(page);
  return {
    changes: page.map(r => {
      const detail = parseDetail(r.detail);
      const trashId = typeof detail?.trash_id === 'number' ? detail.trash_id : null;
      return {
        id: r.id, at: isoAt(r.at), via: r.via, token_name: r.token_name, by: actorLabel(r.via, r.token_name),
        action: r.action, column: r.column_name, summary: r.summary, detail,
        ...(trashId !== null ? { in_trash: live.has(trashId) } : {}),
      };
    }),
    next_before: more ? page[page.length - 1].id : null,
    kept_days: CHANGE_LOG_DAYS,
  };
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

// Of the trash items these lines name, the ones still in the trash whole.
function trashStillThere(rows: ChangeRow[]): Set<number> {
  const ids = rows.map(r => parseDetail(r.detail)?.trash_id).filter((v): v is number => typeof v === 'number');
  if (ids.length === 0) return new Set();
  return new Set(db.prepare(`SELECT id FROM trash_items WHERE id IN (SELECT value FROM json_each(?))
    AND state = 'kept'`).pluck().all(JSON.stringify(ids)) as number[]);
}

// A history read's query (?before=&limit=&column=, or the same as JSON).
export function historyAsk(q: Record<string, unknown>):
  { before?: number; limit?: number; column?: string } | { error: string } {
  const int = (v: unknown): number | undefined | null => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const before = int(q.before);
  const limit = int(q.limit);
  if (before === null) return { error: 'before must be a positive whole number (a change id).' };
  if (limit === null) return { error: `limit must be a whole number from 1 to ${CHANGE_LOG_PAGE_MAX}.` };
  const column = typeof q.column === 'string' && q.column ? q.column : undefined;
  return { before, limit, column };
}

// Lines older than CHANGE_LOG_DAYS go, a slice at a time.
export async function pruneChangeLog(): Promise<void> {
  const del = db.prepare(`DELETE FROM sheet_changes WHERE id IN (SELECT id FROM sheet_changes
    WHERE at < datetime('now', ?) ORDER BY at LIMIT ?)`);
  while (del.run(`-${CHANGE_LOG_DAYS} days`, CHANGE_LOG_PRUNE_SLICE).changes > 0) await yieldToRequests();
}
