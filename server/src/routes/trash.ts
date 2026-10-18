// The Trash page (cookie session), mounted at /api/trash: the account's
// deleted tables, sheets and batches of rows (services/trash-read.ts), restore
// (several at once, or rows picked from a batch), delete for good, and a
// batch's rows as CSV. /api/v1/trash and the MCP trash tools share the
// services; deleting for good is only here.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { contentDispositionFilename } from '../lib/csv-safety';
import { responseWriter } from '../lib/csv-write';
import { listTrash, readTrashRows } from '../services/trash-read';
import { holdersFirst, restoreFromTrash, writeTrashCsv } from '../services/trash-actions';
import { TRASH_IDS_MAX } from '../lib/constants';
import { restoreRows } from '../services/trash-restore';
import { purgeTrashItems } from '../services/trash-purge';
import { parseTrashIds, trashListAsk, trashRowsAsk } from '../services/trash-input';

const router = express.Router();
router.use(authenticateToken);

router.get('/', (req: AuthRequest, res) => {
  try {
    const ask = trashListAsk(req.query as Record<string, unknown>);
    if ('error' in ask) return res.status(400).json({ error: ask.error });
    res.json(listTrash(req.userId!, ask));
  } catch (error) {
    console.error('Trash list error:', error);
    res.status(500).json({ error: 'Failed to read the trash' });
  }
});

router.get('/:id/rows', (req: AuthRequest, res) => {
  try {
    const ask = trashRowsAsk(req.query as Record<string, unknown>);
    if ('error' in ask) return res.status(400).json({ error: ask.error });
    const out = readTrashRows(req.userId!, Number(req.params.id), ask);
    if ('fail' in out) return res.status(out.fail === 'not_found' ? 404 : 400).json({ error: out.message });
    res.json(out);
  } catch (error) {
    console.error('Trash rows error:', error);
    res.status(500).json({ error: 'Failed to read the rows' });
  }
});

router.get('/:id/csv', async (req: AuthRequest, res) => {
  try {
    const out = await writeTrashCsv(req.userId!, Number(req.params.id), responseWriter(res), name => {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', contentDispositionFilename(name, 'csv'));
    });
    if ('fail' in out) return res.status(404).json({ error: 'No batch of rows in the trash with that id.' });
    res.end();
  } catch (error) {
    console.error('Trash CSV error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download the rows' });
    else res.destroy();
  }
});

// { ids: [...] }: tables first, then sheets, then rows, so one restored with
// what holds it goes through.
router.post('/restore', async (req: AuthRequest, res) => {
  try {
    const ids = parseTrashIds((req.body ?? {}).ids);
    if (!ids) return res.status(400).json({ error: `ids must list 1 to ${TRASH_IDS_MAX} trash ids.` });
    res.json({ results: await restoreFromTrash(req.userId!, holdersFirst(req.userId!, ids)) });
  } catch (error) {
    console.error('Trash restore error:', error);
    res.status(500).json({ error: 'Failed to restore' });
  }
});

// { seqs: [...] }: rows picked from one batch.
router.post('/:id/restore-rows', async (req: AuthRequest, res) => {
  try {
    const seqs = (req.body ?? {}).seqs;
    if (!Array.isArray(seqs)) return res.status(400).json({ error: 'seqs must list the rows to restore.' });
    const out = await restoreRows(req.userId!, Number(req.params.id), seqs as number[]);
    if ('fail' in out) {
      const status = out.fail === 'not_found' ? 404 : out.fail === 'conflict' ? 409 : 400;
      return res.status(status).json({ error: out.message, ...(out.busy ? { busy: true } : {}),
        ...(out.blockingRun ? { blockingRun: out.blockingRun } : {}) });
    }
    res.json(out.ok);
  } catch (error) {
    console.error('Trash restore rows error:', error);
    res.status(500).json({ error: 'Failed to restore the rows' });
  }
});

// { ids: [...] }: gone for good, in the background (services/trash-purge.ts).
router.post('/delete', (req: AuthRequest, res) => {
  try {
    const ids = parseTrashIds((req.body ?? {}).ids);
    if (!ids) return res.status(400).json({ error: `ids must list 1 to ${TRASH_IDS_MAX} trash ids.` });
    res.json({ deleting: purgeTrashItems(req.userId!, ids) });
  } catch (error) {
    console.error('Trash delete error:', error);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

export default router;
