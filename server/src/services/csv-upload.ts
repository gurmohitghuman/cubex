// The file sent to an upload link (routes/file-links.ts), through the same
// parse and commit as an upload in the app (services/csv-import.ts). The body
// streams to the uploads folder (never held in memory; cut off past
// MAX_CSV_UPLOAD_BYTES), is scanned and imported from there, then removed.
// A restart mid-import leaves nothing behind (lib/uploads.ts empties the
// folder at boot, and lib/import-undo.ts takes out a half-done import).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { UPLOAD_DIR } from '../lib/uploads';
import { CELL_MAX_BASIC, MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { scanCsvFile, CsvHeaderCollisionError } from '../lib/csv-import-parse';
import { importCsv, type CsvImportOutcome } from './csv-import';

export type UploadFailure = { fail: 'too_big' | 'aborted' | 'parse'; error: string };

export const tooBigMessage = (): string =>
  `The file is bigger than the ${Math.round(MAX_CSV_UPLOAD_BYTES / (1024 * 1024))} MB import limit.`;

// What an import reports, the same through import_csv and an upload link. The
// extras appear only when they happened, so a normal import isn't noisier.
export function importSummary(
  ok: Extract<CsvImportOutcome, { ok: unknown }>['ok'], replace: boolean,
): Record<string, unknown> {
  return {
    rows_imported: ok.rowsImported,
    starting_row: ok.startingRow,
    new_columns: ok.newColumns,
    replaced: replace,
    ...(ok.droppedSeedRows ? { dropped_blank_starter_rows: true } : {}),
    ...(ok.truncatedCells > 0 ? {
      truncated_cells: ok.truncatedCells,
      note: `${ok.truncatedCells} cell(s) were longer than ${CELL_MAX_BASIC} characters and were cut to fit.`,
    } : {}),
  };
}

export async function importUploadedCsv(
  body: Readable, sheetId: string, userId: string, replace: boolean,
): Promise<CsvImportOutcome | UploadFailure> {
  const file = path.join(UPLOAD_DIR, crypto.randomBytes(16).toString('hex'));
  try {
    const refused = await receive(body, file, MAX_CSV_UPLOAD_BYTES);
    if (refused) return refused;
    let scanned;
    try {
      scanned = await scanCsvFile(file);
    } catch (parseErr) {
      return {
        fail: 'parse',
        error: parseErr instanceof CsvHeaderCollisionError
          ? parseErr.message
          : 'The file could not be parsed. Check it is UTF-8 CSV with a header row.',
      };
    }
    // A replace would empty the sheet, columns and all.
    if (replace && scanned.summary.columns.length === 0) {
      return { fail: 'parse', error: 'The file has no header row, so nothing was replaced.' };
    }
    // The import streams the file again, so it is removed only after.
    return await importCsv(sheetId, userId, scanned, replace, { bumpDataVersion: true, seedEmptyRow: false });
  } finally {
    await fs.promises.rm(file, { force: true })
      .catch(err => console.warn('Failed to clean up an uploaded CSV:', err));
  }
}

class TooBig extends Error {}

// The body into `file`, owner-only, at most `max` bytes. null once it has all
// arrived; past the cap the stream stops (the connection drops, since the rest
// is never read; the route refuses a declared oversize Content-Length up front).
export async function receive(body: Readable, file: string, max: number): Promise<UploadFailure | null> {
  let bytes = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > max) done(new TooBig());
      else done(null, chunk);
    },
  });
  try {
    await pipeline(body, cap, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    return null;
  } catch (err) {
    if (err instanceof TooBig) return { fail: 'too_big', error: tooBigMessage() };
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || (err as Error).message === 'aborted') {
      return { fail: 'aborted', error: 'The upload stopped before the whole file arrived.' };
    }
    throw err;
  }
}
