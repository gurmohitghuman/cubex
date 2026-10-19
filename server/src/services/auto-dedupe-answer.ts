// What a REST or MCP answer says about auto-dedupe after rows were added or
// edited (services/auto-dedupe-settle.ts): which of the call's rows weren't
// kept, which older rows they replaced, checks still waiting, and how to put
// just those rows back from the trash.
import { AUTO_DEDUPE_LIST_IDS } from '../lib/constants-dedupe';
import { TRASH_RESTORE_PICK_MAX } from '../lib/constants';
import { getTrashDays, trashExpiry } from '../lib/trash/store';
import { db } from '../lib/db';
import type { AutoDedupeOutcome } from './auto-dedupe-settle';
import type { ImportDedupe } from './auto-dedupe-import';
import type { Surface } from './trash-answer';

export interface AutoDedupeAnswer {
  column: string;
  keep: string;
  // Row ids (at most AUTO_DEDUPE_LIST_IDS each; the counts are whole).
  not_kept: string[]; not_kept_count: number;
  replaced: string[]; replaced_count: number;
  checking_later?: number;
  // seqs: at most AUTO_DEDUPE_LIST_IDS (seqs_count is whole); when cut,
  // seq_ranges ([first, last] each, every seq between) names them all.
  trash?: {
    trash_id: number; seqs: number[]; seqs_count: number; seq_ranges?: Array<[number, number]>;
    restorable_until?: string; how_to_restore: string;
  };
  note?: string;
}

// Sorted seqs as [first, last] runs: one transaction's rows get consecutive
// seqs, so usually one (at most AUTO_DEDUPE_LIST_IDS are listed).
function seqRanges(seqs: readonly number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const q of seqs) {
    const last = out[out.length - 1];
    if (last && q === last[1] + 1) last[1] = q;
    else if (out.length < AUTO_DEDUPE_LIST_IDS) out.push([q, q]);
    else break;
  }
  return out;
}

// `mine`: the ids of the rows this call added or edited.
export function autoDedupeAnswer(
  userId: string, d: AutoDedupeOutcome | null, mine: ReadonlySet<string>, surface: Surface,
): AutoDedupeAnswer | undefined {
  if (!d || (d.removed.length === 0 && d.waiting === 0)) return undefined;
  const notKept = d.removed.filter(r => mine.has(r.id)).map(r => r.id);
  const replaced = d.removed.filter(r => !mine.has(r.id)).map(r => r.id);
  const out: AutoDedupeAnswer = {
    column: d.column, keep: d.keep,
    not_kept: notKept.slice(0, AUTO_DEDUPE_LIST_IDS), not_kept_count: notKept.length,
    replaced: replaced.slice(0, AUTO_DEDUPE_LIST_IDS), replaced_count: replaced.length,
  };
  if (d.waiting > 0) out.checking_later = d.waiting;
  if (d.removed.length === 0) return out;
  if (d.trashId === null) {
    out.note = 'Deleted for good: Settings keeps deleted items 0 days, so nothing went to the trash.';
    return out;
  }
  const at = db.prepare('SELECT deleted_at FROM trash_items WHERE id = ? AND user_id = ?').pluck()
    .get(d.trashId, userId) as string | undefined;
  const cut = d.seqs.length > AUTO_DEDUPE_LIST_IDS;
  out.trash = {
    trash_id: d.trashId, seqs: d.seqs.slice(0, AUTO_DEDUPE_LIST_IDS), seqs_count: d.seqs.length,
    ...(cut ? { seq_ranges: seqRanges(d.seqs) } : {}),
    restorable_until: at ? trashExpiry(at, getTrashDays(userId)) : undefined,
    how_to_restore: howToRestore(d.trashId, d.seqs, surface),
  };
  return out;
}

// A CSV import's: how many rows went (its own, or older ones they replaced),
// whether checks go on in the background, and the batch they went to (it
// holds every row auto-dedupe removed from the sheet that day).
export function importDedupeAnswer(
  userId: string, d: ImportDedupe | null, surface: Surface,
): Record<string, unknown> | undefined {
  if (!d) return undefined;
  const out: Record<string, unknown> = {
    column: d.column, keep: d.keep, not_kept_rows: d.notKept, replaced_rows: Math.max(0, d.removed - d.notKept),
  };
  if (d.left) out.checking_later = true;
  if (d.trashId !== null) {
    out.trash_id = d.trashId;
    out.see_them = surface === 'mcp'
      ? `list_trash with trash_id ${d.trashId} lists the rows auto-dedupe removed from this sheet today.`
      : `GET /api/v1/trash/${d.trashId} lists the rows auto-dedupe removed from this sheet today.`;
  }
  return out;
}

// Just these rows back: a restore takes at most TRASH_RESTORE_PICK_MAX seqs a call.
function howToRestore(trashId: number, seqs: number[], surface: Surface): string {
  const perCall = seqs.length > TRASH_RESTORE_PICK_MAX
    ? `, ${TRASH_RESTORE_PICK_MAX.toLocaleString('en-US')} a call` : '';
  const list = seqs.length > AUTO_DEDUPE_LIST_IDS
    ? `the ${seqs.length.toLocaleString('en-US')} seqs in seq_ranges (each from its first to its last)${perCall}`
    : JSON.stringify(seqs);
  return surface === 'mcp'
    ? `restore_from_trash with trash_id ${trashId} and seqs ${list} puts just these rows back.`
    : `POST /api/v1/trash/${trashId}/restore with {"seqs": ...} (${list}) puts just these rows back.`;
}
