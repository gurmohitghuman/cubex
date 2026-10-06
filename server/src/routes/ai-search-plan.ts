// The AI column drawer's web search options for a model: what each engine and
// mode costs, whether the model has search of its own, and the plan for the
// current choice or why it can't run (lib/web-search-plan.ts). The same plan a
// preview, an estimate and a run get, so what the drawer says is what runs.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { SEARCH_MODES, parseSearchOptions } from '../lib/web-search-options';
import { hasNativeSearch, nativeTakesCap, planWebSearch, webSearchSummary } from '../lib/web-search-plan';
import { enginePrice, nativeSearchProvider } from '../lib/web-search-pricing';
import { searchCatalog } from '../services/web-search-catalog';

const router = express.Router();
router.use(authenticateToken);

// GET /api/ai/search-plan?model=openai/gpt-6-luna&engine=parallel&mode=fast&cap=1
router.get('/search-plan', async (req: AuthRequest, res) => {
  try {
    const model = typeof req.query.model === 'string' ? req.query.model.trim() : '';
    if (!model) return res.status(400).json({ error: 'model is required' });
    const catalog = await searchCatalog(req.userId!);
    const provider = nativeSearchProvider(model);
    const modes = (engine: 'exa' | 'parallel') =>
      SEARCH_MODES[engine].map(mode => ({ mode, price: enginePrice(engine, mode, catalog.prices) }));
    const options = parseSearchOptions({ engine: req.query.engine, mode: req.query.mode, maxPerRow: req.query.cap }, true);
    const planned = 'error' in options ? options : planWebSearch(options.ok!, model, catalog);
    res.json({
      prices: { exa: modes('exa'), parallel: modes('parallel'), perplexity: enginePrice('perplexity', null, catalog.prices) },
      native: {
        available: hasNativeSearch(model, catalog), provider: provider.name, price: provider.price,
        takesCap: nativeTakesCap(model),
      },
      plan: 'ok' in planned ? webSearchSummary(planned.ok) : null,
      error: 'error' in planned ? planned.error : null,
    });
  } catch (error) {
    console.error('Search plan error:', error);
    res.status(500).json({ error: 'Failed to work out the search settings' });
  }
});

export default router;
