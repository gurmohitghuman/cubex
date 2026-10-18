// GET /v1/usage: what runs cost, by column (deleted ones too), day or run, for
// one sheet (sheet_id) or the whole account, over a range (range, or from and
// to). format=csv downloads every row. Shared with MCP get_usage and the app's
// Usage view (services/usage.ts).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { readUsage, usageAsk } from '../services/usage';
import { writeUsageCsv } from '../services/usage-csv';

const router = express.Router();

router.get('/usage', requireScope('read'), async (req: TokenAuthRequest, res) => {
  try {
    const { sheet_id: sheetId, format, ...rest } = req.query as Record<string, unknown>;
    if (sheetId !== undefined && (typeof sheetId !== 'string' || !sheetId)) {
      return res.status(400).json({ error: 'sheet_id must be a sheet id' });
    }
    if (format !== undefined && format !== 'json' && format !== 'csv') {
      return res.status(400).json({ error: 'format must be json or csv' });
    }
    const out = usageAsk(req.userId!, typeof sheetId === 'string' ? sheetId : null, rest);
    if ('fail' in out) return res.status(out.fail === 'not_found' ? 404 : 400).json({ error: out.message });
    if (format === 'csv') return await writeUsageCsv(res, out.ok.scope, out.ok.query.groupBy, out.ok.name);
    res.json(readUsage(out.ok.scope, out.ok.query));
  } catch (error) {
    console.error('GET /v1/usage error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to read the usage' });
    else res.destroy();
  }
});

export default router;
