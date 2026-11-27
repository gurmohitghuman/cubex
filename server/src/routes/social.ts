// Social research tables in the app (services/social-*.ts): what the dialog can offer, make one, read it, and find
// posts (the estimate first). One implementation with /api/v1 and MCP (services/social-agent.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { UUID_PATTERN } from '../lib/constants';
import { getSheetForClient, getTableForClient } from '../lib/sheet-crud-helpers';
import { timeZoneOf } from '../lib/ai-visibility/check';
import { usdLimitOf } from '../lib/cost-ceiling';
import { socialInputOf } from '../lib/social/input';
import { createSocialTable } from '../services/social-create';
import { estimateFindPosts, startFindPosts } from '../services/social-find';
import { socialOptions } from '../services/social-options';
import { loadSocial, socialView } from '../services/social-store';
import { runFailHttpStatus } from '../services/run-shared';

const router = express.Router();
router.use(authenticateToken);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const recordOf = (req: AuthRequest, res: express.Response) => {
  const rec = UUID_PATTERN.test(req.params.id) ? loadSocial(req.userId!, req.params.id) : undefined;
  if (!rec) res.status(404).json({ error: 'Social research table not found' });
  return rec;
};

// The platforms offered now, with what a search and each step cost.
router.get('/options', async (_req: AuthRequest, res) => {
  try { res.json({ platforms: await socialOptions() }); } catch (error) {
    console.error('Social research options error:', error);
    res.status(502).json({ error: "Can't reach treg's catalog right now. Try again in a moment." });
  }
});

// POST /: a new table; answers like POST /api/hiring (the table, its sheets and the sheet to open), plus the record.
router.post('/', async (req: AuthRequest, res) => {
  try {
    const input = socialInputOf(isObj(req.body) ? req.body : {}, 'app');
    if ('error' in input) return res.status(400).json({ error: input.error });
    const made = await createSocialTable(req.userId!, input.ok);
    if ('fail' in made) return res.status(runFailHttpStatus(made)).json({ error: made.message });
    const t = made.ok;
    const posts = Object.values(t.postsSheets) as string[];
    const sheets = [t.searchesSheetId, ...posts, ...(t.commentsSheetId ? [t.commentsSheetId] : [])];
    res.json({
      ...(getTableForClient(t.tableId, req.userId!) as object),
      sheets: sheets.map(id => getSheetForClient(id, req.userId!)),
      sheetId: posts[0], social: socialView(loadSocial(req.userId!, t.id)!),
    });
  } catch (error) {
    console.error('Create social research table error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to make the social research table' });
  }
});

router.get('/:id', (req: AuthRequest, res) => {
  const rec = recordOf(req, res);
  if (rec) res.json({ social: socialView(rec) });
});

// POST /:id/find-posts: {estimateOnly, timeZone, maxCostUsd}: the estimate answers {estimate}; the start
// (maxCostUsd: the most the estimate showed) answers once every platform's search has started, or 409
// {over_ceiling, estimate} when the most is now higher.
router.post('/:id/find-posts', async (req: AuthRequest, res) => {
  try {
    const rec = recordOf(req, res);
    if (!rec) return;
    const b = isObj(req.body) ? req.body : {};
    if (b.estimateOnly === true) {
      const est = await estimateFindPosts(req.userId!, rec);
      if ('fail' in est) return res.status(runFailHttpStatus(est)).json({ error: est.message });
      return res.json({ estimate: est.ok });
    }
    const most = usdLimitOf(b.maxCostUsd, 'maxCostUsd');
    if ('error' in most || most.value === null) {
      return res.status(400).json({ error: 'maxCostUsd is required: the most the estimate showed.' });
    }
    const out = await startFindPosts(req.userId!, rec, { maxCostUsd: most.value, timeZone: timeZoneOf(b.timeZone) });
    if ('fail' in out) {
      return res.status(runFailHttpStatus(out)).json({ error: out.message,
        ...(out.estimate ? { over_ceiling: true, estimate: out.estimate } : {}) });
    }
    res.json(out.ok);
  } catch (error) {
    console.error('Find posts error:', error);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't find posts" });
  }
});

export default router;
