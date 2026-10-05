import express from 'express';
import previewRoutes from './http-preview';
import runStartRoutes from './http-run-start';

// Thin aggregator for the two HTTP run-start routes. Split out of one file so each
// route stays under the 200-line cap (POST /preview lives in http-preview.ts, POST
// /run in http-run-start.ts; the shared column validation is in
// lib/http-run-validate.ts). Mounted by routes/http.ts with no path prefix, so the
// routes stay /preview and /run.
const router = express.Router();
router.use(previewRoutes);
router.use(runStartRoutes);

export default router;
