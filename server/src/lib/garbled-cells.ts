// The cells of a CSV import that look garbled (lib/clean/fix-encoding.ts:
// text read with the wrong character set), counted as the import writes them,
// with the first IMPORT_GARBLED_SAMPLES kept to show as
// {"<row id>": {"<column>": "<value>"}}, each value cut to
// IMPORT_GARBLED_SAMPLE_CHARS (never half of a surrogate pair). The objects
// are keyed by row ids and column names, so they have no prototype: a column
// named "__proto__" or "constructor" is an ordinary key.
import { looksGarbled } from './clean/fix-encoding';
import { IMPORT_GARBLED_SAMPLE_CHARS, IMPORT_GARBLED_SAMPLES } from './constants-clean';

export type GarbledSamples = Record<string, Record<string, string>>;

function clip(value: string): string {
  if (value.length <= IMPORT_GARBLED_SAMPLE_CHARS) return value;
  const end = value.charCodeAt(IMPORT_GARBLED_SAMPLE_CHARS - 1);
  return value.slice(0, end >= 0xD800 && end <= 0xDBFF ? IMPORT_GARBLED_SAMPLE_CHARS - 1 : IMPORT_GARBLED_SAMPLE_CHARS);
}

export class GarbledTally {
  cells = 0;
  readonly samples: GarbledSamples = Object.create(null);
  private kept = 0;

  // A cell as written: counted when it looks garbled, kept while there's room.
  check(rowId: string, column: string, value: string): void {
    if (!looksGarbled(value)) return;
    this.cells++;
    if (this.kept >= IMPORT_GARBLED_SAMPLES) return;
    this.kept++;
    const row = this.samples[rowId] ?? (this.samples[rowId] = Object.create(null) as Record<string, string>);
    row[column] = clip(value);
  }
}
