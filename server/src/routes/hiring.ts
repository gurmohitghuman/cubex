// Hiring tables in the app (services/hiring-*.ts): make one, read it, check it (the estimate first).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { getSheetForClient, getTableForClient } from '../lib/sheet-crud-helpers';
import { parseHiringInput } from '../lib/hiring/input';
import { timeZoneOf } from '../lib/ai-visibility/check';
import { createHiringTable } from '../services/hiring-create';
import { estimateHiringCheck, startHiringCheck } from '../services/hiring-check';
import { hiringFor, hiringView } from '../services/hiring-store';
import { runFailHttpStatus } from '../services/run-shared';

const router = express.Router();
router.use(authenticateToken);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const recordOf = (req: AuthRequest, res: express.Response) => {
  const rec = UUID_PATTERN.test(req.params.id) ? hiringFor(req.userId!, req.params.id) : null;
  if (!rec) res.status(404).json({ error: 'Hiring table not found' });
  return rec;
};

// POST / — a new table; answers like POST /api/tables/sample (the table, its
// sheets and the sheet to open), plus the record.
router.post('/', async (req: AuthRequest, res) => {
  try {
    const input = parseHiringInput(req.body);
    if (typeof input === 'string') return res.status(400).json({ error: input });
    const made = await createHiringTable(req.userId!, input);
    if ('fail' in made) return res.status(runFailHttpStatus(made)).json({ error: made.message });
    const t = made.ok;
    res.json({
      ...(getTableForClient(t.tableId, req.userId!) as object),
      sheets: [t.companiesSheetId, t.rolesSheetId, t.searchesSheetId].map(id => getSheetForClient(id, req.userId!)),
      sheetId: t.companiesSheetId, hiring: hiringView(hiringFor(req.userId!, t.id)!),
    });
  } catch (error) {
    console.error('Create hiring table error:', error);
    res.status(500).json({ error: 'Failed to make the hiring table' });
  }
});

router.get('/:id', (req: AuthRequest, res) => {
  try {
    const rec = recordOf(req, res);
    if (rec) res.json({ hiring: hiringView(rec) });
  } catch (error) {
    console.error('Read hiring table error:', error);
    res.status(500).json({ error: 'Failed to read the hiring table' });
  }
});

// POST /:id/check — {estimateOnly, timeZone}: the estimate answers {plan, estimate};
// the check answers once its search has started.
router.post('/:id/check', async (req: AuthRequest, res) => {
  try {
    const rec = recordOf(req, res);
    if (!rec) return;
    const b = isObj(req.body) ? req.body : {};
    // The asker's time zone, for the check's day (UTC when it isn't one).
    const opts = { timeZone: timeZoneOf(b.timeZone) };
    if (b.estimateOnly === true) {
      const est = await estimateHiringCheck(req.userId!, rec, opts);
      if ('fail' in est) return res.status(runFailHttpStatus(est)).json({ error: est.message });
      return res.json(est);
    }
    const out = await startHiringCheck(req.userId!, rec, opts);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json({ check: out.ok, hiring: hiringView(hiringFor(req.userId!, rec.id) ?? rec) });
  } catch (error) {
    console.error('Check hiring table error:', error);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't check the hiring table" });
  }
});

export default router;
