import express from 'express';
import fs from 'fs';
import path from 'path';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN, MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { scanCsvFile, CsvHeaderCollisionError } from '../lib/csv-import-parse';
import { importCsv } from '../services/csv-import';
import { csvUploadMiddleware } from './sheets-shared';

const router = express.Router();
router.use(authenticateToken);

// POST /:id/import — rate-limit BEFORE multer so we reject the 30MB upload
// without parsing it once the user is over budget. csvUploadMiddleware wraps
// multer.single() to convert MulterError into a friendly 400.
//
// PARSE FIRST, MUTATE LATER: parse runs to completion, then the commit phase
// (validation + single transaction + replace run-abort choreography) is shared
// with /api/v1 in services/csv-import.ts.
router.post('/:id/import', csvUploadMiddleware, async (req: AuthRequest, res) => {
  const cleanupUpload = () => {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); }
      catch (err) { console.warn('Failed to clean up uploaded CSV:', err); }
    }
  };
  try {
    const { id } = req.params;
    if (!id || !UUID_PATTERN.test(id)) { cleanupUpload(); return res.status(400).json({ error: 'Invalid sheet ID format' }); }
    const { replaceData = 'false' } = req.body as { replaceData?: string };
    const replace = replaceData === 'true';

    if (!req.file) return res.status(400).json({ error: 'CSV file is required' });
    if (req.file.size > MAX_CSV_UPLOAD_BYTES) {
      cleanupUpload();
      const mb = Math.round(MAX_CSV_UPLOAD_BYTES / (1024 * 1024));
      return res.status(400).json({ error: `File size exceeds ${mb}MB limit` });
    }
    if (path.extname(req.file.originalname).toLowerCase() !== '.csv') {
      cleanupUpload();
      return res.status(400).json({ error: 'Only CSV files are allowed' });
    }

    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) { cleanupUpload(); return res.status(404).json({ error: 'Sheet not found' }); }

    let scanned;
    try {
      scanned = await scanCsvFile(req.file.path);
    } catch (parseErr) {
      cleanupUpload();
      console.error('CSV parse error:', parseErr);
      // A header-collision is a specific, actionable user error — surface its
      // message instead of the generic one.
      const msg = parseErr instanceof CsvHeaderCollisionError
        ? parseErr.message
        : 'CSV could not be parsed. Check the file is valid UTF-8 CSV.';
      return res.status(400).json({ error: msg });
    }

    // The import streams the file again, so the upload is removed only after it.
    const result = await importCsv(id, req.userId!, scanned, replace);
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

    // newColumns lets the client surface "imported into M new columns" and
    // scroll the grid to the first one (they land to the RIGHT of existing
    // columns, which is otherwise off-screen and looks like a no-op import).
    res.json({
      message: 'CSV imported successfully',
      rowsImported: result.ok.rowsImported,
      startingRow: result.ok.startingRow,
      newColumns: result.ok.newColumns,
      // >0 when some cells exceeded the basic cell cap and were truncated, so
      // the client can warn the user their import was clipped.
      truncatedCells: result.ok.truncatedCells,
    });
  } catch (error) {
    console.error('Import CSV error:', error);
    cleanupUpload();
    res.status(500).json({ error: 'Failed to import CSV' });
  }
});

export default router;
