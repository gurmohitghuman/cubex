// The grid's search and its value counts (reads only):
//   GET /:id/search?q=&row=&column=&position=&inclusive=1&back=1&view=&dv=&rg=
//     the next (back: previous) matching cell after row/column (services/sheet-search.ts)
//   GET /:id/search/count?q=&row=&column=&view=   how many cells match, and how many before row/column
//   GET /:id/values?column=&view=                 a column's most common values (services/value-counts.ts)
// `view` is the view the tab shows: another one active now answers 409 viewChanged.
// A request the tab gave up on (a newer keystroke) stops between slices.
import express, { type Response } from 'express';
import { authenticateToken, type AuthRequest } from '../middleware/auth';
import { findMatch, countMatches, type SearchCell } from '../services/sheet-search';
import { columnValueCounts } from '../services/value-counts';
import { watchGone } from '../lib/request-gone';

const router = express.Router();
router.use(authenticateToken);

const int = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
};
const cellOf = (q: AuthRequest['query']): SearchCell | undefined => {
  const row = int(q.row);
  return row !== undefined && typeof q.column === 'string' ? { row, column: q.column } : undefined;
};

type Fail = { fail: 'invalid' | 'not_found' | 'view_changed'; error: string };
function sendFail(res: Response, f: Fail) {
  if (f.fail === 'view_changed') return res.status(409).json({ error: f.error, viewChanged: true });
  return res.status(f.fail === 'not_found' ? 404 : 400).json({ error: f.error });
}

router.get('/:id/search', async (req: AuthRequest, res) => {
  try {
    const q = req.query, from = cellOf(q);
    const position = int(q.position), dv = int(q.dv), rg = int(q.rg);
    const out = await findMatch(req.params.id, req.userId!, {
      q: q.q, viewId: q.view, inclusive: q.inclusive === '1', back: q.back === '1', stop: watchGone(res),
      ...(from ? { from: { ...from, ...(position !== undefined ? { position } : {}) } } : {}),
      ...(dv !== undefined && rg !== undefined ? { versions: { data_version: dv, row_generation: rg } } : {}),
    });
    if ('stopped' in out) return res.status(499).end();
    if ('fail' in out) return sendFail(res, out);
    res.json(out.ok);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

router.get('/:id/search/count', async (req: AuthRequest, res) => {
  try {
    const at = cellOf(req.query);
    const out = await countMatches(req.params.id, req.userId!, {
      q: req.query.q, viewId: req.query.view, stop: watchGone(res), ...(at ? { at } : {}),
    });
    if ('stopped' in out) return res.status(499).end();
    if ('fail' in out) return sendFail(res, out);
    res.json(out.ok);
  } catch (error) {
    console.error('Search count error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

router.get('/:id/values', async (req: AuthRequest, res) => {
  try {
    const out = await columnValueCounts(req.params.id, req.userId!, req.query.column, req.query.view,
      watchGone(res));
    if ('stopped' in out) return res.status(499).end();
    if ('fail' in out) return sendFail(res, out);
    if ('tooMany' in out) return res.json({ tooMany: true, error: out.tooMany });
    if ('busy' in out) return res.json({ busy: true, error: out.busy });
    res.json(out.ok);
  } catch (error) {
    console.error('Value counts error:', error);
    res.status(500).json({ error: 'Counting values failed' });
  }
});

export default router;
