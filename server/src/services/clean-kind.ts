// Clean data columns as a derived kind (derived-kind.ts): one source column,
// cleaned by a pure cleaner (lib/clean/). A source value the cleaner can't
// read (it cleans to empty) is flagged, and the fill counts it as blanked.
import { db } from '../lib/db';
import { cleanColumnFor, loadCleanColumn, type CleanColumnRow } from '../lib/clean-columns';
import { cleanerForRecord } from '../lib/clean/cleaners';
import type { DerivedCell, DerivedKind } from './derived-kind';
import { inputText } from './derived-write';

export const CLEANING = 'cleaning a column';

export const cleanKind: DerivedKind<CleanColumnRow> = {
  id: 'clean',
  table: 'clean_columns',
  busy: CLEANING,
  noun: 'clean column',
  load: loadCleanColumn,
  forColumn: cleanColumnFor,
  inputs: rec => [rec.source_column],
  sameSetup: (a, b) => a.cleaner === b.cleaner && a.options === b.options
    && a.source_column === b.source_column && a.column_name === b.column_name,
  async open(rec) {
    const clean = cleanerForRecord(rec.cleaner, rec.options);
    if (!clean) return { error: `This version of Cubex doesn't know the cleaner "${rec.cleaner}".` };
    const cell = (inputs: unknown[]): DerivedCell => {
      const source = inputText(inputs[0]);
      const value = source === '' ? '' : clean(source);
      return value === '' && /\S/.test(source) ? { value, filled: false, flag: '' } : { value, filled: value !== '' };
    };
    return {
      compute(rows, budgetMs) {
        const until = Date.now() + budgetMs;
        const cells: DerivedCell[] = [];
        for (const inputs of rows) {
          if (cells.length > 0 && Date.now() >= until) break;
          cells.push(cell(inputs));
        }
        return cells;
      },
      prepare: async () => {},
      failure: () => null,
      dispose: () => {},
    };
  },
  advance(rec, cursor, counts) {
    db.prepare(`UPDATE clean_columns SET fill_cursor = ?, filled_rows = filled_rows + ?,
      blanked_rows = blanked_rows + ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND fill_status = 'filling'`)
      .run(cursor, counts.filled, counts.flagged, rec.id, rec.user_id);
  },
};
