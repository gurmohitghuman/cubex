// PUBLIC, UNAUTHENTICATED: the one-time links an MCP agent gets from
// create_upload_link and create_download_link (lib/file-links.ts). Mounted in
// index.ts with no auth; the token in the path IS the capability, as with
// webhooks. Cheap rejections come first, any link that is unknown, used,
// expired or whose access token is gone gets the same 404, and an upload's body
// is read only once its link checks out and its size is known. The global body
// parsers skip /api/files (applyServerMiddleware), so an upload streams
// straight to disk.
import express from 'express';
import { contentDispositionFilename } from '../lib/csv-safety';
import { planSheetExport, type RowCondition } from '../lib/csv-export';
import { responseWriter, writeSheetCsv } from '../lib/csv-write';
import { findFileLink, linkOptions, releaseFileLink, useFileLink } from '../lib/file-links';
import { busyMessage, sheetBusyWith, withSheetRead } from '../lib/sheet-busy';
import { redactError } from '../lib/redact';
import { MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { FILE_LINK_TOKEN_PATTERN } from '../lib/api-v1-constants';
import { importSummary, importUploadedCsv, tooBigMessage } from '../services/csv-upload';

const router = express.Router();

const notFound = (res: express.Response) => res.status(404).json({
  error: "This link doesn't work: it was already used, has expired, or never existed. Ask for a new one.",
});
const stillWorks = ' The link still works until it expires.';
const usedUp = ' This link is used up; ask for a new one.';

// Express 4 doesn't catch an async handler's rejection, so every throw ends here.
async function upload(req: express.Request, res: express.Response) {
  try {
    await receiveUpload(req, res);
  } catch (error) {
    console.error('Upload link import failed:', redactError(error));
    if (!res.headersSent && !res.destroyed) res.status(500).json({ error: 'The import failed. Ask for a new link and try again.' });
  }
}

async function receiveUpload(req: express.Request, res: express.Response) {
  const { token } = req.params;
  if (!FILE_LINK_TOKEN_PATTERN.test(token)) return notFound(res);
  // Refused before the link is looked up or used, so it still works after.
  if (req.is('multipart/form-data')) {
    return res.status(415).json({
      error: `Send the file itself as the request body, as in: curl -T leads.csv '<this link>'. Form uploads (curl -F) aren't accepted.${stillWorks}`,
    });
  }
  if (String(req.headers['content-encoding'] ?? 'identity').toLowerCase() !== 'identity') {
    return res.status(415).json({ error: `Send the file uncompressed.${stillWorks}` });
  }
  // The size must come up front: it is how a cut-off upload is told from a
  // whole one. A chunked body (curl reading a pipe) can be ended cleanly by a
  // client that gives up (curl does, on a timeout), and the truncated file
  // would import as if complete.
  const length = req.headers['content-length'];
  if (req.headers['transfer-encoding'] || length === undefined) {
    return res.status(411).json({
      error: `Send the file with its size, as in: curl -T leads.csv '<this link>' (from a file, not a pipe).${stillWorks}`,
    });
  }
  if (Number(length) > MAX_CSV_UPLOAD_BYTES) return res.status(413).json({ error: tooBigMessage() + stillWorks });
  if (Number(length) === 0) return res.status(400).json({ error: `The file is empty.${stillWorks}` });

  const link = findFileLink(token, 'upload');
  if (!link) return notFound(res);
  const busyWith = sheetBusyWith(link.sheet_id);
  if (busyWith) return res.status(409).json({ error: busyMessage(busyWith) + stillWorks, busy: true });
  if (!useFileLink(link)) return notFound(res);

  const replace = linkOptions<{ mode: string }>(link).mode === 'replace';
  const result = await importUploadedCsv(req, link.sheet_id, link.user_id, replace);
  if (!('fail' in result)) return void res.status(201).json(importSummary(result.ok, replace));
  // Busy (a heavy job or an export got there first): nothing was imported, so
  // the link may try again.
  const kept = result.fail === 'busy' && releaseFileLink(link);
  if (result.fail === 'aborted' || res.destroyed) return; // the client is gone
  if (result.fail === 'busy') {
    return void res.status(409).json({ error: result.error + (kept ? stillWorks : usedUp), busy: true });
  }
  if (result.fail === 'locked') {
    return void res.status(409).json({
      error: `Cannot import into column(s) an active run owns: ${result.columns.join(', ')}. Stop the run first.${usedUp}`,
      locked_columns: result.columns,
    });
  }
  res.status(result.fail === 'too_big' ? 413 : 400).json({ error: result.error + usedUp });
}
router.put('/upload/:token', upload);
router.post('/upload/:token', upload);

// A link checker or preview fetching the URL must not use the link up, so
// HEAD is refused (Express would otherwise answer it with the GET handler).
router.head('/download/:token', (_req, res) => { res.status(405).set('Allow', 'GET').end(); });

router.get('/download/:token', async (req, res) => {
  const { token } = req.params;
  if (!FILE_LINK_TOKEN_PATTERN.test(token)) return notFound(res);
  try {
    const link = findFileLink(token, 'download');
    if (!link) return notFound(res);
    const plan = planSheetExport(link.sheet_id, link.user_id, linkOptions<{ columns: string[]; where: RowCondition[] }>(link));
    if ('fail' in plan) {
      return plan.fail === 'not_found' ? notFound(res)
        : res.status(409).json({ error: `${plan.error} The sheet changed since this link was made; ask for a new one.` });
    }
    // The link is used inside the read hold, so a busy sheet leaves it unused.
    const outcome = await withSheetRead(link.sheet_id, async () => {
      if (!useFileLink(link)) return 'used' as const;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', contentDispositionFilename(plan.sheetName, 'csv'));
      await writeSheetCsv(link.sheet_id, link.user_id, plan, responseWriter(res));
      res.end();
      return 'sent' as const;
    });
    if (outcome === 'used') return notFound(res);
    if (typeof outcome === 'object') return res.status(409).json({ error: outcome.busy + stillWorks, busy: true });
  } catch (error) {
    console.error('Download link failed:', redactError(error));
    if (!res.headersSent) res.status(500).json({ error: 'The download failed. Ask for a new link and try again.' });
    else res.destroy();
  }
});

export default router;
