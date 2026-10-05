import multer from 'multer';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { db } from '../lib/db';
import { MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { UPLOAD_DIR } from '../lib/uploads';
import { AuthRequest } from '../middleware/auth';

export interface SheetRow {
  id: string;
  table_id: string;
  user_id: string;
  name: string;
  position: number;
  column_order: string | null;
  sort_state: string | null;
  empty_filter: string | null;
  // "Text contains" filter, JSON {col: {type:'contains', value}} (migration 031).
  column_filters: string | null;
  default_ai_model: string | null;
  // Optimistic-concurrency token for row_index meaning (migration 021). Bumped
  // by physical sort + CSV replace; echoed by row_index-targeting writes; a
  // mismatch ⇒ 409 so a stale client reloads instead of writing wrong rows.
  row_generation: number;
  created_at: string;
  updated_at: string;
}

export function normalizeColumnName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// Moved to lib/ so services can use it; re-exported for the existing callers.
export { getLockedRunColumns } from '../lib/run-locked-columns';

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_CSV_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Require the .csv extension. We used to also accept mimetype=text/csv, but
    // mimetype is client-controlled — an attacker could upload "exploit.exe" with
    // mimetype text/csv and get the file written to the upload folder before the route's
    // extension check rejected it. Extension-only is the safer gate.
    if (path.extname(file.originalname).toLowerCase() === '.csv') cb(null, true);
    else cb(new Error('Only CSV files are allowed'));
  },
});

// Wraps multer.single() to convert MulterError (e.g. LIMIT_FILE_SIZE when upload
// exceeds MAX_CSV_UPLOAD_BYTES) into a friendly 400 instead of an unhandled
// exception that bubbles to the global 500 handler. Also cleans up any partial
// temp file multer wrote before aborting.
export const csvUploadMiddleware = (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  upload.single('file')(req, res, (err: any) => {
    if (!err) return next();

    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); }
      catch (cleanupErr) { console.warn('Failed to clean up partial upload:', cleanupErr); }
    }

    if (err.name === 'MulterError') {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(MAX_CSV_UPLOAD_BYTES / (1024 * 1024));
        return res.status(400).json({ error: `CSV file exceeds the ${mb}MB upload limit.` });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'Upload one file at a time.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.code}` });
    }

    // fileFilter rejection (e.g. "Only CSV files are allowed") arrives here as a
    // plain Error. Pass through its message.
    return res.status(400).json({ error: err.message || 'Failed to upload CSV.' });
  });
};
