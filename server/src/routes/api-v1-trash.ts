// /v1/trash: what was deleted (rows, sheets, tables), kept for the days set in
// Settings, and putting it back. GET /trash (q, kind, sheet_id, before, limit),
// GET /trash/:id, GET /trash/:id/rows (after, limit, column, contains),
// GET /trash/:id/csv, POST /trash/restore { trash_ids }, POST /trash/:id/restore
// { seqs? } (rows picked from a batch). Deleting for good is only in the app.
// Also GET /sheets/:id/history: the sheet's change log. Shared with MCP and the
// app (services/trash-*.ts, services/sheet-history.ts).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { TRASH_IDS_MAX } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { contentDispositionFilename } from '../lib/csv-safety';
import { responseWriter } from '../lib/csv-write';
import { getTrashEntry, listTrash, readTrashRows } from '../services/trash-read';
import { holdersFirst, restoreFromTrash, writeTrashCsv } from '../services/trash-actions';
import { restoreRows } from '../services/trash-restore';
import { parseTrashIds, trashListAsk, trashRowsAsk } from '../services/trash-input';
import { historyAsk, readSheetHistory } from '../services/sheet-history';

const router = express.Router();
const idOf = (req: TokenAuthRequest) => Number(req.params.id);

router.get('/trash', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const ask = trashListAsk(req.query as Record<string, unknown>);
    if ('error' in ask) return res.status(400).json({ error: ask.error });
    res.json(listTrash(req.userId!, ask));
  } catch (error) {
    console.error('GET /v1/trash error:', error);
    res.status(500).json({ error: 'Failed to read the trash' });
  }
});

router.get('/trash/:id', requireScope('read'), (req: TokenAuthRequest, res) => {
  const entry = getTrashEntry(req.userId!, idOf(req));
  if (!entry) return res.status(404).json({ error: 'Nothing in the trash with that id.' });
  res.json(entry);
});

router.get('/trash/:id/rows', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const ask = trashRowsAsk(req.query as Record<string, unknown>);
    if ('error' in ask) return res.status(400).json({ error: ask.error });
    const out = readTrashRows(req.userId!, idOf(req), ask);
    if ('fail' in out) return res.status(out.fail === 'not_found' ? 404 : 400).json({ error: out.message });
    res.json(out);
  } catch (error) {
    console.error('GET /v1/trash/:id/rows error:', error);
    res.status(500).json({ error: 'Failed to read the rows' });
  }
});

router.get('/trash/:id/csv', requireScope('read'), async (req: TokenAuthRequest, res) => {
  try {
    const out = await writeTrashCsv(req.userId!, idOf(req), responseWriter(res), name => {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', contentDispositionFilename(name, 'csv'));
    });
    if ('fail' in out) return res.status(404).json({ error: 'No batch of rows in the trash with that id.' });
    res.end();
  } catch (error) {
    console.error('GET /v1/trash/:id/csv error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download the rows' });
    else res.destroy();
  }
});

router.post('/trash/restore', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try {
    const ids = parseTrashIds((req.body ?? {}).trash_ids);
    if (!ids) return res.status(400).json({ error: `trash_ids must list 1 to ${TRASH_IDS_MAX} trash ids.` });
    res.json({ results: await restoreFromTrash(req.userId!, holdersFirst(req.userId!, ids)) });
  } catch (error) {
    console.error('POST /v1/trash/restore error:', error);
    res.status(500).json({ error: 'Failed to restore' });
  }
});

router.post('/trash/:id/restore', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try {
    const seqs = (req.body ?? {}).seqs;
    if (seqs !== undefined && !Array.isArray(seqs)) return res.status(400).json({ error: 'seqs must be a list.' });
    if (seqs === undefined) {
      const [result] = await restoreFromTrash(req.userId!, [idOf(req)]);
      if (result.restored) return res.json(result.restored);
      const status = result.fail === 'not_found' ? 404 : result.fail === 'bad_request' ? 400 : 409;
      return res.status(status).json({
        error: result.error, ...(result.busy ? { busy: true } : {}),
        ...(result.blocking_run ? { blocking_run: result.blocking_run } : {}),
      });
    }
    const out = await restoreRows(req.userId!, idOf(req), seqs as number[]);
    if ('fail' in out) {
      const status = out.fail === 'not_found' ? 404 : out.fail === 'conflict' ? 409 : 400;
      return res.status(status).json({ error: out.message, ...(out.busy ? { busy: true } : {}),
        ...(out.blockingRun ? { blocking_run: out.blockingRun } : {}) });
    }
    res.json(out.ok);
  } catch (error) {
    console.error('POST /v1/trash/:id/restore error:', error);
    res.status(500).json({ error: 'Failed to restore' });
  }
});

router.get('/sheets/:id/history', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    if (!verifySheetOwnership(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const ask = historyAsk(req.query as Record<string, unknown>);
    if ('error' in ask) return res.status(400).json({ error: ask.error });
    res.json(readSheetHistory(req.params.id, req.userId!, ask));
  } catch (error) {
    console.error('GET /v1/sheets/:id/history error:', error);
    res.status(500).json({ error: 'Failed to read the history' });
  }
});

export default router;
