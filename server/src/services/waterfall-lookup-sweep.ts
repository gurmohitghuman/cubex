// Looked-up columns that waterfall lookup steps read, for the lookup
// background work (services/lookup-purge.ts, in the lookup worker): what an
// index must keep for them (the text index for a contains step), and letting go
// of an index no lookup column and no waterfall reads. What waterfalls read is
// read from their newest runs (lib/waterfall/lookup-refs.ts), kept for
// WATERFALL_LOOKUP_NEEDS_MS and read again before anything is let go. An index
// is never let go in its first WATERFALL_LOOKUP_GRACE_MINUTES: a dry run isn't a
// column's newest run, and a run just started may not be read yet. One let go
// too soon is made again by the step that needs it: a rebuild, never a wrong
// answer.
import { db } from '../lib/db';
import { WATERFALL_LOOKUP_GRACE_MINUTES, WATERFALL_LOOKUP_NEEDS_MS } from '../lib/constants';
import { waterfallLookupNeeds } from '../lib/waterfall/lookup-refs';
import type { LookupSource } from './lookup-source';

export type WaterfallNeed = 'text' | 'plain' | null;
type Needs = Map<string, Map<string, boolean>>;

let read = { at: 0, byUser: new Map<string, Needs>() };

// Old enough to be let go (SQL over lookup_sources' created_at).
export const PAST_GRACE = `created_at < datetime('now', '-${WATERFALL_LOOKUP_GRACE_MINUTES} minutes')`;

// What the account's waterfalls need of this index; `fresh` reads them again first.
export function waterfallNeed(src: Pick<LookupSource, 'user_id' | 'sheet_id' | 'column_name'>, fresh = false)
  : WaterfallNeed {
  if (Date.now() - read.at >= WATERFALL_LOOKUP_NEEDS_MS) read = { at: Date.now(), byUser: new Map() };
  let needs = fresh ? undefined : read.byUser.get(src.user_id);
  if (!needs) {
    needs = waterfallLookupNeeds(src.user_id);
    read.byUser.set(src.user_id, needs);
  }
  const contains = needs.get(src.sheet_id)?.get(src.column_name);
  return contains === undefined ? null : contains ? 'text' : 'plain';
}

// Whether nothing needs it, read again when the kept list says so (so a run that started since counts).
export const noWaterfallNeeds = (src: LookupSource, need: (n: WaterfallNeed) => boolean): boolean =>
  !need(waterfallNeed(src)) && !need(waterfallNeed(src, true));

// Indexes only waterfalls made (no lookup column reads them) that no waterfall reads now go;
// their keys are deleted in slices (lookup_purges).
export function releaseWaterfallSources(): void {
  const unread = `NOT EXISTS (SELECT 1 FROM lookup_columns c
    WHERE c.other_sheet_id = lookup_sources.sheet_id AND c.match_column = lookup_sources.column_name)`;
  const candidates = db.prepare(`SELECT * FROM lookup_sources WHERE ${PAST_GRACE} AND ${unread}`)
    .all() as LookupSource[];
  for (const src of candidates) {
    if (!noWaterfallNeeds(src, n => n !== null)) continue;
    // Again inside the write lock: a lookup column may have come since.
    db.transaction(() => {
      db.prepare(`DELETE FROM lookup_sources WHERE id = ? AND ${unread}`).run(src.id);
    }).immediate();
  }
}
