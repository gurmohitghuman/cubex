// POST /v1/sheets/:id/import — multipart CSV (field `file`, optional `replace`
// = 'true'). Same pipeline as the UI route: multer (CSV size cap,
// .csv extension) → parse → the shared commit service
// (services/csv-import.ts). The v1 router's JSON parser ignores multipart
// bodies, so multer is the only body reader here — still strictly post-auth.
// Replace mode bumps row_generation (open tabs loud-reload via the change
// poll); both modes bump data_version.
import express from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../lib/db';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { scanCsvFile, CsvHeaderCollisionError } from '../lib/csv-import-parse';
import { importCsv } from '../services/csv-import';
import { csvUploadMiddleware } from './sheets-shared';

const router = express.Router();

router.post('/sheets/:id/import', requireScope('write'), csvUploadMiddleware, async (req: TokenAuthRequest, res) => {
  const cleanupUpload = () => {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); }
      catch (err) { console.warn('Failed to clean up uploaded CSV:', err); }
    }
  };
  try {
    const sheetId = req.params.id;
    if (!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, req.userId!)) {
      cleanupUpload();
      return res.status(404).json({ error: 'Sheet not found' });
    }
    const replace = (req.body as { replace?: string })?.replace === 'true';

    if (!req.file) return res.status(400).json({ error: 'CSV file is required (multipart field "file")' });
    if (req.file.size > MAX_CSV_UPLOAD_BYTES) {
      cleanupUpload();
      const mb = Math.round(MAX_CSV_UPLOAD_BYTES / (1024 * 1024));
      return res.status(400).json({ error: `File size exceeds ${mb}MB limit` });
    }
    if (path.extname(req.file.originalname).toLowerCase() !== '.csv') {
      cleanupUpload();
      return res.status(400).json({ error: 'Only CSV files are allowed' });
    }

    let scanned;
    try {
      scanned = await scanCsvFile(req.file.path);
    } catch (parseErr) {
      cleanupUpload();
      console.error('CSV parse error (v1):', parseErr);
      const msg = parseErr instanceof CsvHeaderCollisionError
        ? parseErr.message
        : 'CSV could not be parsed. Check the file is valid UTF-8 CSV.';
      return res.status(400).json({ error: msg });
    }

    // The import streams the file again, so the upload is removed only after it.
    const result = await importCsv(sheetId, req.userId!, scanned, replace, { bumpDataVersion: true, seedEmptyRow: false });
    cleanupUpload();
    if ('fail' in result) {
      if (result.fail === 'busy') return res.status(409).json({ error: result.error });
      if (result.fail === 'locked') {
        return res.status(409).json({
          error: `Cannot import into column(s) an active run owns: ${result.columns.join(', ')}. Stop the run first.`,
          lockedColumns: result.columns,
        });
      }
      return res.status(400).json({ error: result.error });
    }

    res.status(201).json({
      rows_imported: result.ok.rowsImported,
      starting_row: result.ok.startingRow,
      new_columns: result.ok.newColumns,
      truncated_cells: result.ok.truncatedCells,
      replaced: replace,
      dropped_blank_starter_rows: result.ok.droppedSeedRows,
    });
  } catch (error) {
    console.error('POST /v1/sheets/:id/import error:', error);
    cleanupUpload();
    res.status(500).json({ error: 'Failed to import CSV' });
  }
});

export default router;
