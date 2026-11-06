// Whether what a lookup's fill reads in the other sheet changed, unseen, since
// it wrote its last rows: a fill of a column it reads (a clean, formula or
// lookup column, or stored answers added as a column), or a run writing one
// (not an auto-run batch: lookup-fill-wait.ts), that started and ended while
// the lookup waited for something else (a run, a sort or import, its index,
// its own sheet) or between two of its looks. Asked each time the fill would
// go on with rows written: yes, and it looks every row up again from the
// first, so every row comes from one version of those values (lookups are
// free: a start over it didn't need costs only time).
//
// In this process the answer is exact: each fill's end is counted per column
// (derived-fill-wait.ts fillEnded), and a run is a new ai_runs / http_runs row
// (rowids only grow). What the fill last went on with is kept per lookup, with
// its cursor. A cursor this process didn't move there (a restart finds the
// fill going) is answered from the records instead: a fill record of a column
// it reads, or such a run, touched at or after the lookup's last advance (its
// updated_at, in seconds: a tie counts as a change).
import { db } from '../lib/db';
import {
  addAiRunColumns, addHttpRunColumns, type AiRunWrites, type HttpRunWrites,
} from '../lib/run-locked-columns';
import type { LookupColumnRow } from '../lib/lookup-columns';
import { fillsEnded } from './derived-fill-wait';

interface Seen { cursor: number; fills: string; aiRow: number; httpRow: number }
const seen = new Map<string, Seen>();

type Rec = Pick<LookupColumnRow, 'id' | 'user_id' | 'other_sheet_id' | 'fill_cursor' | 'updated_at'>;

const lastRowid = (table: 'ai_runs' | 'http_runs'): number =>
  (db.prepare(`SELECT MAX(rowid) FROM ${table}`).pluck().get() as number | null) ?? 0;

const writesOne = (ai: AiRunWrites[], http: HttpRunWrites[], reads: string[]): boolean => {
  const written = new Set<string>();
  for (const r of ai) addAiRunColumns(r, written);
  for (const r of http) addHttpRunColumns(r, written);
  return reads.some(c => written.has(c));
};

// Runs there (set up only: never run; auto-run batches: it goes on after them) since these rowids, by rowid.
function runsSince(rec: Rec, reads: string[], aiRow: number, httpRow: number): boolean {
  const ai = db.prepare(`SELECT column_name, output_columns, data_column FROM ai_runs
    WHERE rowid > ? AND +sheet_id = ? AND +user_id = ? AND setup_only = 0`)
    .all(aiRow, rec.other_sheet_id, rec.user_id) as AiRunWrites[];
  const http = db.prepare(`SELECT config, master_column_name FROM http_runs
    WHERE rowid > ? AND +sheet_id = ? AND +user_id = ? AND setup_only = 0 AND autorun_id IS NULL`)
    .all(httpRow, rec.other_sheet_id, rec.user_id) as HttpRunWrites[];
  return writesOne(ai, http, reads);
}

// From the records: a fill of a column it reads, or such a run, touched since its last advance.
function touchedSince(rec: Rec, reads: string[]): boolean {
  const at = [rec.other_sheet_id, rec.user_id, rec.updated_at, JSON.stringify(reads)];
  const fill = db.prepare(`SELECT 1 FROM clean_columns WHERE sheet_id = ? AND user_id = ? AND updated_at >= ?
      AND column_name IN (SELECT value FROM json_each(?))
    UNION ALL SELECT 1 FROM formula_columns WHERE sheet_id = ? AND user_id = ? AND updated_at >= ?
      AND column_name IN (SELECT value FROM json_each(?))
    UNION ALL SELECT 1 FROM lookup_columns WHERE sheet_id = ? AND user_id = ? AND updated_at >= ?
      AND column_name IN (SELECT value FROM json_each(?))
    UNION ALL SELECT 1 FROM enrichment_field_jobs WHERE sheet_id = ? AND user_id = ? AND updated_at >= ?
      AND column_name IN (SELECT value FROM json_each(?))
    LIMIT 1`).get(...at, ...at, ...at, ...at);
  if (fill) return true;
  const ai = db.prepare(`SELECT column_name, output_columns, data_column FROM ai_runs
    WHERE sheet_id = ? AND user_id = ? AND setup_only = 0 AND updated_at >= ?`)
    .all(rec.other_sheet_id, rec.user_id, rec.updated_at) as AiRunWrites[];
  const http = db.prepare(`SELECT config, master_column_name FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND setup_only = 0 AND autorun_id IS NULL AND updated_at >= ?`)
    .all(rec.other_sheet_id, rec.user_id, rec.updated_at) as HttpRunWrites[];
  return writesOne(ai, http, reads);
}

// At a look where nothing it reads is filling and its fill would go on: true when it must start over.
// Otherwise what it goes on with is kept (a slice's advance carries it to the new cursor: advancedTo).
export function readsChangedUnseen(rec: Rec, reads: string[]): boolean {
  const now: Seen = {
    cursor: rec.fill_cursor, fills: reads.map(c => `${c}\u0000${fillsEnded(rec.other_sheet_id, c)}`).join('\u0001'),
    aiRow: lastRowid('ai_runs'), httpRow: lastRowid('http_runs'),
  };
  const was = seen.get(rec.id);
  const changed = rec.fill_cursor > 0 && (was?.cursor === rec.fill_cursor
    ? was.fills !== now.fills || runsSince(rec, reads, was.aiRow, was.httpRow)
    : touchedSince(rec, reads));
  if (changed) seen.delete(rec.id);
  else seen.set(rec.id, now);
  return changed;
}

// Its own slice moved the cursor (inside the slice's transaction): what it went on with holds after it.
export function advancedTo(id: string, cursor: number): void {
  const was = seen.get(id);
  if (was) was.cursor = cursor;
}
