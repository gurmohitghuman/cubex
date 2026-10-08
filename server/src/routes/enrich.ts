// Enrichment UI routes (cookie session). Thin: the logic lives in
// services/enrich-*.ts so the MCP tools and /api/v1 share it.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { TREG_TOOL_ID_PATTERN, UUID_PATTERN } from '../lib/constants';
import { searchTools, getTool, featuredTools, type CatalogFailure } from '../services/enrich-catalog';
import { estimateEnrichment, readEnrichBalance, sheetSetupInfo } from '../services/enrich-setup';
import { parseEstimateInput } from '../lib/enrich-estimate-input';
import { toolAccess } from '../services/enrich-access';
import { enrichSpend, spendWindow } from '../services/enrich-spend';
import runRoutes from './enrich-runs';

const router = express.Router();
router.use(authenticateToken);

// A read that needs the saved treg key: 409 { noKey } without one, else 502.
function sendReadFailure(res: express.Response, read: { fail: string; message: string }) {
  const noKey = read.fail === 'no_key';
  res.status(noKey ? 409 : 502).json({ error: read.message, ...(noKey ? { noKey: true } : {}) });
}

function sendFailure(res: express.Response, f: CatalogFailure) {
  const status = f.fail === 'not_found' ? 404 : f.fail === 'hidden' ? 422 : 502;
  res.status(status).json({ error: f.message });
}

// ?q= searches treg's catalog; no query returns the "Popular" jobs.
router.get('/tools', async (req: AuthRequest, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      const featured = await featuredTools();
      return 'ok' in featured ? res.json({ featured: true, tools: featured.ok }) : sendFailure(res, featured);
    }
    const found = await searchTools(q);
    return 'ok' in found ? res.json({ featured: false, tools: found.ok }) : sendFailure(res, found);
  } catch (error) {
    console.error('Enrichment tool search error:', error);
    res.status(500).json({ error: 'Failed to search tools' });
  }
});

router.get('/tools/:toolId', async (req: AuthRequest, res) => {
  try {
    const { toolId } = req.params;
    if (!TREG_TOOL_ID_PATTERN.test(toolId)) return res.status(400).json({ error: 'Invalid tool id' });
    const tool = await getTool(toolId);
    return 'ok' in tool ? res.json({ tool: tool.ok }) : sendFailure(res, tool);
  } catch (error) {
    console.error('Enrichment tool detail error:', error);
    res.status(500).json({ error: 'Failed to load the tool' });
  }
});

// How the user's treg team would be served for this tool: their own key, a
// free route, or treg's key (and, for a waterfall, per provider).
router.get('/tools/:toolId/access', async (req: AuthRequest, res) => {
  try {
    const { toolId } = req.params;
    if (!TREG_TOOL_ID_PATTERN.test(toolId)) return res.status(400).json({ error: 'Invalid tool id' });
    const read = await toolAccess(req.userId!, toolId);
    if ('ok' in read) return res.json({ access: read.ok });
    sendReadFailure(res, read);
  } catch (error) {
    console.error('Enrichment tool access error:', error);
    res.status(500).json({ error: 'Failed to load tool access' });
  }
});

// Set up step: the sheet's row counts (all, and its saved filter's) and room
// for new columns.
router.get('/sheets/:id/setup', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid sheet ID format' });
    const info = sheetSetupInfo(req.userId!, id);
    if (!info) return res.status(404).json({ error: 'Sheet not found' });
    res.json(info);
  } catch (error) {
    console.error('Enrichment setup read error:', error);
    res.status(500).json({ error: 'Failed to read the sheet' });
  }
});

// The estimate box. A pure read: nothing is created and nothing is called.
router.post('/estimate', async (req: AuthRequest, res) => {
  try {
    const parsed = parseEstimateInput(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const out = await estimateEnrichment(req.userId!, parsed.ok);
    return 'ok' in out ? res.json(out.ok) : sendFailure(res, out);
  } catch (error) {
    console.error('Enrichment estimate error:', error);
    res.status(500).json({ error: 'Failed to estimate' });
  }
});

// The treg balance, shown in the estimate box.
router.get('/balance', async (req: AuthRequest, res) => {
  try {
    const read = await readEnrichBalance(req.userId!);
    if ('ok' in read) return res.json(read.ok);
    sendReadFailure(res, read);
  } catch (error) {
    console.error('treg balance read error:', error);
    res.status(500).json({ error: 'Failed to read the treg balance' });
  }
});

// Settings' spend card: the last 7, 30 or 90 days from Cubex's ledger.
router.get('/spend', async (req: AuthRequest, res) => {
  try {
    res.json(await enrichSpend(req.userId!, spendWindow(req.query.days)));
  } catch (error) {
    console.error('Enrichment spend read error:', error);
    res.status(500).json({ error: 'Failed to read enrichment spending' });
  }
});

// Starting, reading and resuming runs (routes/enrich-runs.ts).
router.use(runRoutes);

export default router;
