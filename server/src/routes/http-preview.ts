import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { buildRowsMapFromRows, verifySheetOwnership, getSheetColumns, type RowDB } from '../lib/sql-helpers';
import { withSheetColumns } from '../lib/http-request-template';
import { httpTemplateError } from '../lib/http-template-validate';
import { makeHTTPRequest, redactSecrets, type HTTPAPIConfig } from '../lib/http-request';
import { extractOutcome } from '../lib/jsonpath-extract';
import { validateHttpRunColumns } from '../lib/http-run-validate';
import { trimForPreview } from '../lib/preview-trim';
import { HTTP_MAX_CONCURRENCY, HTTP_PREVIEW_CONCURRENCY } from '../lib/constants';

const router = express.Router();

// Preview: pull up to N sample rows, run the request live for the first few, return
// what the user's template would produce. Used by the modal before they commit.
router.post('/preview', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const { sheetId, config }: { sheetId: string; config: HTTPAPIConfig } = req.body;
    if (!sheetId || !config) return res.status(400).json({ error: 'Sheet ID and config are required' });
    if (!config.requestConfig) return res.status(400).json({ error: 'Invalid HTTP API config' });
    if (!verifySheetOwnership(sheetId, req.userId!)) {
      return res.status(404).json({ error: 'Sheet not found' });
    }

    // Allow zero responseMapping entries: the kid-friendly Manual flow lets
    // the user run a preview WITHOUT declaring fields, then click leaves on
    // the JSON tree to define the mapping. We still extract any user-supplied
    // mappings, but an empty mapping is a valid "just show me the raw response".
    //
    // Same shared validator as /run, but checkExisting=false (preview creates no
    // columns) and no master (preview has none). It still rejects case-insensitive
    // dup mapping names + invalid names, and sanitizes — so a preview behaves like
    // the run it's previewing.
    const templateError = httpTemplateError(config.requestConfig, getSheetColumns(sheetId, req.userId!, false), req.userId!);
    if (templateError) return res.status(400).json({ error: templateError });
    const responseMapping = config.responseMapping || [];
    const validation = validateHttpRunColumns(sheetId, req.userId!, responseMapping, undefined, false);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    responseMapping.forEach((m, i) => { m.columnName = validation.sanitizedMappingColumns![i]; });

    // Clamp previewSize. A raw config.previewSize of -1 would become LIMIT -1
    // (unlimited in SQLite) and fan the outbound HTTP calls across nearly the
    // whole sheet. Mirror the AI preview clamp: [1, 20]; that many rows are
    // requested, HTTP_PREVIEW_CONCURRENCY at a time.
    const previewSize = (typeof config.previewSize === 'number' && Number.isFinite(config.previewSize))
      ? Math.max(1, Math.min(Math.floor(config.previewSize), 20))
      : 5;
    const distinctRows = db.prepare(`
      SELECT row_index FROM rows
      WHERE sheet_id = ? AND user_id = ?
      ORDER BY row_index ASC LIMIT ?
    `).all(sheetId, req.userId!, previewSize) as Array<{ row_index: number }>;

    if (distinctRows.length === 0) return res.status(400).json({ error: 'No data available for preview' });

    const rowIndexes = distinctRows.map(r => r.row_index);
    const placeholders = rowIndexes.map(() => '?').join(',');
    const sampleRows = db.prepare(`
      SELECT id, sheet_id, user_id, row_index, data, updated_at FROM rows
      WHERE sheet_id = ? AND user_id = ? AND row_index IN (${placeholders})
      ORDER BY row_index ASC
    `).all(sheetId, req.userId!, ...rowIndexes) as RowDB[];

    const rowsMap = buildRowsMapFromRows(sampleRows);
    const sheetColumns = getSheetColumns(sheetId, req.userId!, false);
    const rows = rowIndexes.map(rowIndex => ({ rowIndex, data: rowsMap.get(rowIndex) || {} }));
    const previewResults: Array<Record<string, unknown>> = [];

    // Whole-preview deadline, mirroring the AI preview's 60s controller. The
    // per-request headers/body timeouts bound stalls, but a drip-feeding
    // upstream could still hold this Express request open across many rows —
    // the signal caps the total.
    const previewController = new AbortController();
    const previewDeadline = setTimeout(() => previewController.abort(), 60_000);
    try {
    // One row's request + extraction; a failure becomes an error result.
    const previewRow = async (row: (typeof rows)[number]): Promise<Record<string, unknown>> => {
      try {
        const responseData = await makeHTTPRequest(config.requestConfig, withSheetColumns(row.data, sheetColumns), req.userId!, previewController.signal);
        const extractedFields: Record<string, any> = {};
        for (const mapping of responseMapping) {
          // extractOutcome (not the silent-null wrapper) so a malformed path that
          // slipped past validation surfaces as a preview error — matching the
          // runner, which fails the row on a path error (Bug 7). A no-match is a
          // normal blank.
          const outcome = extractOutcome(responseData, mapping.jsonPath);
          if (outcome.error) {
            throw new Error(`JSONPath "${mapping.jsonPath}" (column "${mapping.columnName}"): ${outcome.error}`);
          }
          extractedFields[mapping.columnName] = outcome.matched ? outcome.value : null;
        }
        return {
          rowIndex: row.rowIndex, status: 'success', reason: 'Request successful',
          extractedFields,
          // Raw response is what the click-to-pick tree renders. Caller can
          // walk this tree, click a leaf, and we'll derive the JSONPath for
          // them. Capped at 100KB per row to keep the preview payload sane.
          rawResponse: trimForPreview(responseData),
          requestSummary: {
            method: config.requestConfig.method,
            url: config.requestConfig.url.substring(0, 100) + (config.requestConfig.url.length > 100 ? '...' : ''),
          },
        };
      } catch (error: any) {
        // Per-row preview error intentionally surfaced. Redact secrets in case the
        // upstream API echoed a Bearer/API-key in its error response.
        return {
          rowIndex: row.rowIndex, status: 'error',
          error: redactSecrets(error?.message || 'Unknown error'),
          extractedFields: {},
        };
      }
    };
    // Every previewed row, results in row order. The first goes alone, so a
    // request that's the same for every row (no row tokens) is cached for the
    // rest; then HTTP_PREVIEW_CONCURRENCY at a time (never above the run limit).
    // Past the deadline the remaining rows are skipped (they'd abort too).
    previewResults[0] = await previewRow(rows[0]);
    let next = 1;
    const worker = async () => {
      while (next < rows.length && !previewController.signal.aborted) {
        const i = next++;
        previewResults[i] = await previewRow(rows[i]);
      }
    };
    const width = Math.min(HTTP_PREVIEW_CONCURRENCY, HTTP_MAX_CONCURRENCY, rows.length - 1);
    await Promise.all(Array.from({ length: width }, worker));
    } finally {
      clearTimeout(previewDeadline);
    }

    res.json({ previewResults: previewResults.filter(Boolean) });
  } catch (error: any) {
    console.error('Preview error:', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

export default router;
