// A lookup column's preview (a pure read: nothing is created or written): the
// first rows whose value isn't empty, with what the lookup gives for each, for
// the app's Lookup dialog and an agent's lookup_column preview. When the other
// column's keys are built and current, it matches exactly as the fill would;
// otherwise (a column nobody looks up yet) it reads the other sheet's first
// LOOKUP_PREVIEW_OTHER_ROWS rows and says how many it checked.
import { db } from '../lib/db';
import {
  LOOKUP_MAX_MATCHES, LOOKUP_PREVIEW_CELL_CHARS, LOOKUP_PREVIEW_OTHER_ROWS, LOOKUP_PREVIEW_ROWS,
  LOOKUP_PREVIEW_SCAN_ROWS,
} from '../lib/constants';
import { jsonPath } from '../lib/sql-rows';
import { countRows, getSheetColumns } from '../lib/sql-helpers';
import { containsTooShort, lookupKey, lookupText, lookupValue } from '../lib/lookup/normalize';
import { checkLookupInput, type LookupColumnInput, type LookupSetup } from './lookup-column';
import { lookupSourceOf, lookupSourceState } from './lookup-source';
import { lookupSheetBlocked } from './lookup-blocked';
import { matchContains, matchEquals, type LookupMatches } from './lookup-probe';
import { lookupAnswer, lookupNeed, type LookupAsk } from './lookup-answer';
import type { RunFail } from './run-shared';

export interface LookupPreviewSample {
  row: number;            // row_index
  value: string;          // this row's value, cut to LOOKUP_PREVIEW_CELL_CHARS
  result: string;         // the cell the fill would write ('' = empty)
  error: string | null;   // why the lookup can't answer this row
}

export interface LookupPreview {
  column: string | null;       // the lookup column's name, when given
  existing: boolean;           // a lookup column already: saving looks every row up again
  otherSheet: string;
  otherRows: number;           // rows in the other sheet
  checkedRows: number | null;  // rows of it read for the preview (null: all, through its keys)
  samples: LookupPreviewSample[];
}

const cut = (s: string) =>
  (s.length > LOOKUP_PREVIEW_CELL_CHARS ? `${s.slice(0, LOOKUP_PREVIEW_CELL_CHARS - 1)}…` : s);

// Matches against the other sheet's first rows, in sheet order (no keys needed).
function scanMatches(s: LookupSetup, userId: string, values: string[], ask: LookupAsk): LookupMatches[] {
  const need = lookupNeed(ask);
  const rows = db.prepare(`SELECT rowid AS rid, json_extract(data, ?) AS v FROM rows
    WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT ?`)
    .all(jsonPath(s.matchColumn), s.otherSheetId, userId, LOOKUP_PREVIEW_OTHER_ROWS) as
    Array<{ rid: number; v: unknown }>;
  // Each cell's key (or text) worked out once, not once per sample.
  const there = rows.map(r => ({ rid: r.rid, value: lookupValue(r.v) })).filter(r => r.value !== '')
    .map(r => ({ rid: r.rid, key: s.match === 'equals' ? lookupKey(r.value) : lookupText(r.value) }));
  return values.map(value => {
    if (s.match === 'contains' && containsTooShort(value)) return { rids: [], count: 0, over: false, tooShort: true };
    const key = lookupKey(value);
    const hits = there.filter(r => (s.match === 'equals' ? r.key === key : r.key.includes(value)));
    const over = s.match === 'contains' && hits.length > LOOKUP_MAX_MATCHES;
    const want = need.kind === 'first' ? need.want : need.kind === 'any' ? 1 : 0;
    return { rids: hits.slice(0, want).map(h => h.rid), count: hits.length, over };
  });
}

export function previewLookupColumn(
  userId: string, sheetId: string, input: LookupColumnInput,
): { ok: LookupPreview } | RunFail {
  const s = checkLookupInput(userId, sheetId, input, { needColumn: false });
  if ('fail' in s) return s;
  // The first rows (in row order) whose value isn't empty; a run's own words read as empty.
  const picked: Array<{ row: number; value: string; shown: string }> = [];
  for (const r of db.prepare(`SELECT row_index AS i, json_extract(data, ?) AS v FROM rows
    WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT ?`)
    .iterate(jsonPath(s.source), sheetId, userId, LOOKUP_PREVIEW_SCAN_ROWS) as
    IterableIterator<{ i: number; v: unknown }>) {
    const value = lookupValue(r.v);
    if (!value) continue;
    picked.push({ row: r.i, value, shown: cut(typeof r.v === 'string' ? r.v : String(r.v)) });
    if (picked.length >= LOOKUP_PREVIEW_ROWS) break;
  }
  const ask: LookupAsk = {
    otherSheetId: s.otherSheetId, userId, returns: s.returns, returnColumns: s.returnColumns, listLimit: s.limit,
  };
  const columns = getSheetColumns(s.otherSheetId, userId, false);
  const otherRows = countRows(s.otherSheetId, userId);
  const src = lookupSourceOf(s.otherSheetId, userId, s.matchColumn);
  const indexed = !!src && (s.match === 'equals' || src.with_text === 1) && !lookupSheetBlocked(s.otherSheetId)
    && lookupSourceState(src) === 'ready';
  // One read transaction: the keys and the rows they point at agree.
  const cells = db.transaction(() => {
    const matches = indexed
      ? picked.map(p => (s.match === 'equals' ? matchEquals : matchContains)(src!.id, p.value, lookupNeed(ask)))
      : scanMatches(s, userId, picked.map(p => p.value), ask);
    return matches.map(m => lookupAnswer(ask, m, columns));
  })();
  return {
    ok: {
      column: s.column, existing: !!s.existing && !s.isNew, otherSheet: s.otherName, otherRows,
      checkedRows: indexed ? null : Math.min(otherRows, LOOKUP_PREVIEW_OTHER_ROWS),
      samples: picked.map((p, k) => ({
        row: p.row, value: p.shown, result: cut(cells[k].value), error: cells[k].flag ?? null,
      })),
    },
  };
}
