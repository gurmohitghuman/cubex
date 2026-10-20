// AI visibility tables in the app (services/ai-visibility-*.ts): make one, ask
// its engines (an estimate first), check it again, change the brands it looks for.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { getSheetForClient, getTableForClient } from '../lib/sheet-crud-helpers';
import { parseAiVisibilityInput, parseBrands } from '../lib/ai-visibility/input';
import { createAiVisibilityTable } from '../services/ai-visibility-create';
import { aiVisibilityRecord, aiVisibilityView, estimateAsk, startAsk } from '../services/ai-visibility-run';
import { setAiVisibilityBrands } from '../services/ai-visibility-brands';
import { estimateCheck, startCheck } from '../services/ai-visibility-check';
import { timeZoneOf } from '../lib/ai-visibility/check';
import { runFailHttpStatus } from '../services/run-shared';

const router = express.Router();
router.use(authenticateToken);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const recordOf = (req: AuthRequest, res: express.Response) => {
  const rec = UUID_PATTERN.test(req.params.id) ? aiVisibilityRecord(req.userId!, req.params.id) : null;
  if (!rec) res.status(404).json({ error: 'AI visibility table not found' });
  return rec;
};

// POST / — a new table; answers like POST /api/tables/sample (the table, its
// sheets and the sheet to open), plus the record.
router.post('/', async (req: AuthRequest, res) => {
  try {
    const input = parseAiVisibilityInput(req.body);
    if (typeof input === 'string') return res.status(400).json({ error: input });
    const made = await createAiVisibilityTable(req.userId!, input);
    if ('fail' in made) return res.status(made.fail === 'upstream' ? 502 : 400).json({ error: made.message });
    const t = made.ok;
    res.json({
      ...(getTableForClient(t.tableId, req.userId!) as object),
      sheets: [getSheetForClient(t.questionsSheetId, req.userId!), getSheetForClient(t.sitesSheetId, req.userId!)],
      sheetId: t.questionsSheetId, aiVisibility: aiVisibilityView(aiVisibilityRecord(req.userId!, t.id)!),
      problems: t.problems,
    });
  } catch (error) {
    console.error('Create AI visibility table error:', error);
    res.status(500).json({ error: 'Failed to make the AI visibility table' });
  }
});

// POST /:id/ask — {estimateOnly, again}: the questions not asked yet, or every one again.
router.post('/:id/ask', async (req: AuthRequest, res) => {
  try {
    const rec = recordOf(req, res);
    if (!rec) return;
    const b = isObj(req.body) ? req.body : {};
    const again = b.again === true;
    if (b.estimateOnly === true) return res.json({ estimate: await estimateAsk(req.userId!, rec, again) });
    const started = await startAsk(req.userId!, rec, again);
    if ('fail' in started) return res.status(400).json({ error: started.message });
    res.json(started);
  } catch (error) {
    console.error('Ask AI visibility engines error:', error);
    res.status(500).json({ error: "Couldn't ask the engines" });
  }
});

// POST /:id/check — {estimateOnly, timeZone, fresh}: keep the answers in dated sheets, add the
// columns comparing with them, then ask every question again. The estimate
// answers {plan, estimate}; the check answers once its runs have started.
router.post('/:id/check', async (req: AuthRequest, res) => {
  try {
    const rec = recordOf(req, res);
    if (!rec) return;
    const b = isObj(req.body) ? req.body : {};
    // The asker's time zone, for the day in the names (UTC when it isn't one).
    const opts = { timeZone: timeZoneOf(b.timeZone), fresh: b.fresh === true };
    if (b.estimateOnly === true) {
      const est = await estimateCheck(req.userId!, rec, opts);
      if ('fail' in est) return res.status(runFailHttpStatus(est)).json({ error: est.message });
      return res.json(est);
    }
    const out = await startCheck(req.userId!, rec, opts);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    const now = aiVisibilityRecord(req.userId!, rec.id);
    res.json({ check: out.ok, aiVisibility: now ? aiVisibilityView(now) : null });
  } catch (error) {
    console.error('Check AI visibility table again error:', error);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't check the table again" });
  }
});

// PUT /:id/brands — {brand, competitors}: the formulas look for these from now on.
router.put('/:id/brands', async (req: AuthRequest, res) => {
  try {
    const rec = recordOf(req, res);
    if (!rec) return;
    const brands = parseBrands(isObj(req.body) ? req.body : {});
    if (typeof brands === 'string') return res.status(400).json({ error: brands });
    const saved = await setAiVisibilityBrands(req.userId!, rec, brands);
    res.json({ ...saved, aiVisibility: aiVisibilityView(aiVisibilityRecord(req.userId!, rec.id)!) });
  } catch (error) {
    console.error('Save AI visibility brands error:', error);
    res.status(500).json({ error: "Couldn't save the brands" });
  }
});

export default router;
