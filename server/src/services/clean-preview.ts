// A clean column's preview (a pure read: nothing is created or written): the
// first rows whose source holds a value, before and after cleaning, for the
// app's Clean data dialog and an agent's clean_column preview.
import { db } from '../lib/db';
import { CLEAN_PREVIEW_ROWS, CLEAN_PREVIEW_SCAN_ROWS } from '../lib/constants';
import { jsonPath } from '../lib/sql-rows';
import { cleanerFn } from '../lib/clean/cleaners';
import { checkCleanInput, type CleanColumnInput } from './clean-column';
import { inputText as sourceText } from './derived-write';
import type { RunFail } from './run-shared';

export interface CleanPreview {
  column: string;     // the clean column's name (the default when none was given)
  existing: boolean;  // it is a clean column already: running it cleans every row again
  samples: Array<{ row: number; before: string; after: string }>;
}

export function previewCleanColumn(
  userId: string, sheetId: string, input: CleanColumnInput,
): { ok: CleanPreview } | RunFail {
  const s = checkCleanInput(userId, sheetId, input);
  if ('fail' in s) return s;
  const clean = cleanerFn(s.cleaner, s.options);
  const rows = db.prepare(`SELECT row_index AS row, json_extract(data, ?) AS v FROM rows
    WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT ?`)
    .all(jsonPath(s.source), sheetId, userId, CLEAN_PREVIEW_SCAN_ROWS) as Array<{ row: number; v: unknown }>;
  const samples: CleanPreview['samples'] = [];
  for (const r of rows) {
    // A run's own words (⏳, ❌, ⏭️) read as empty, as the fill reads them.
    const before = sourceText(r.v);
    if (!before.trim()) continue;
    samples.push({ row: r.row, before, after: clean(before) });
    if (samples.length >= CLEAN_PREVIEW_ROWS) break;
  }
  return { ok: { column: s.column, existing: !!s.existing && !s.isNew, samples } };
}
