// Auto-run UI routes (cookie session): the column dialog, the drawer's
// checkbox, the sheet header's chip and the CSV import's notice. Thin: the
// logic lives in services/autorun-*.ts (MCP set_auto_run will call the same).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { AUTORUN_NOTICE_PRICE_MS, MAX_ROWS_PER_SHEET, UUID_PATTERN } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { parseConditions } from '../lib/enrich-run-input';
import { runFailHttpStatus } from '../services/run-shared';
import { saveAutorunSettings, setSheetAutorunPaused } from '../services/autorun-settings';
import { autorunTargetView, sheetAutorunView } from '../services/autorun-view';
import { estimateAutorunRows } from '../services/autorun-estimate';
import { parseRuleField } from '../lib/run-condition';
import { dailyLimitView } from '../services/treg-key';

const router = express.Router();
router.use(authenticateToken);

const badSheet = (res: express.Response) => res.status(400).json({ error: 'Invalid sheet ID format' });
const num = (v: unknown): number | null | undefined => (v === undefined || v === null ? null
  : typeof v === 'number' && Number.isFinite(v) ? v : undefined);

router.get('/sheets/:id', (req: AuthRequest, res) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) return badSheet(res);
    if (!verifySheetOwnership(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    // ?column=: the dialog's column too (its outputs, and whether its own key bills it).
    const column = typeof req.query.column === 'string' && req.query.column.length <= 200 ? req.query.column : null;
    res.json({
      ...sheetAutorunView(req.params.id, req.userId!), dailyLimit: dailyLimitView(req.userId!),
      ...(column ? { target: autorunTargetView(req.params.id, req.userId!, column) } : {}),
    });
  } catch (error) {
    console.error('Auto-run read error:', error);
    res.status(500).json({ error: 'Failed to read auto-run' });
  }
});

// Turn a column's auto-run on (with its "Only run if" and daily cap) or off.
router.put('/sheets/:id/columns', async (req: AuthRequest, res) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) return badSheet(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.column !== 'string' || !b.column.trim() || b.column.length > 200) {
      return res.status(400).json({ error: 'Pick a column.' });
    }
    if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
    const where = b.where === undefined || b.where === null ? null : parseConditions(b.where);
    if (typeof where === 'string') return res.status(400).json({ error: where });
    // runIf absent keeps the rule; '' or null clears it.
    const runIf = b.runIf === undefined ? undefined : parseRuleField(b.runIf);
    if (runIf && 'error' in runIf) return res.status(400).json({ error: runIf.error });
    const cap = num(b.dailyCapUsd), rowCap = num(b.dailyRowCap);
    if (cap === undefined || rowCap === undefined) {
      return res.status(400).json({ error: 'The daily cap must be a number.' });
    }
    // The account owner (cookie session) may set up auto-run on saved keys.
    const out = await saveAutorunSettings(req.userId!, req.params.id, {
      column: b.column, enabled: b.enabled, where, dailyCapUsd: cap, dailyRowCap: rowCap,
      ...(runIf ? { runIf: runIf.ok } : {}),
    }, { hasSecretsScope: true });
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(sheetAutorunView(req.params.id, req.userId!));
  } catch (error) {
    console.error('Auto-run save error:', error);
    res.status(500).json({ error: 'Failed to save auto-run' });
  }
});

// The header chip: pause or resume every auto-run on the sheet (or, with a
// column, the dialog's Pause for that column).
router.post('/sheets/:id/pause', (req: AuthRequest, res) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) return badSheet(res);
    const b = (req.body ?? {}) as { paused?: unknown; column?: unknown };
    if (typeof b.paused !== 'boolean') return res.status(400).json({ error: 'paused must be true or false.' });
    if (b.column !== undefined && (typeof b.column !== 'string' || !b.column.trim() || b.column.length > 200)) {
      return res.status(400).json({ error: 'Pick a column.' });
    }
    if (!setSheetAutorunPaused(req.userId!, req.params.id, b.paused, b.column as string | undefined)) {
      return res.status(404).json({ error: 'Sheet not found' });
    }
    res.json(sheetAutorunView(req.params.id, req.userId!));
  } catch (error) {
    console.error('Auto-run pause error:', error);
    res.status(500).json({ error: 'Failed to pause auto-run' });
  }
});

// What N new rows (a CSV import), or a run writing N rows, would set off
// through auto-run. A pure read.
router.post('/sheets/:id/estimate', async (req: AuthRequest, res) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) return badSheet(res);
    const rows = (req.body as { rows?: unknown } | undefined)?.rows;
    if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 0 || rows > MAX_ROWS_PER_SHEET) {
      return res.status(400).json({ error: 'rows must be a row count.' });
    }
    // after: the columns a run writes (the drawer's Run confirm): what it sets off on its rows.
    const after = (req.body as { after?: unknown }).after;
    if (after !== undefined && !(Array.isArray(after) && after.length <= 200
      && after.every(c => typeof c === 'string' && c.length <= 200))) {
      return res.status(400).json({ error: 'after must be a list of column names.' });
    }
    // quick (or after): the Run confirm waits on this, so a price treg's
    // catalog doesn't give in time is left out ("no estimate").
    const quick = after !== undefined || (req.body as { quick?: unknown }).quick === true;
    const out = await estimateAutorunRows(req.userId!, req.params.id, rows, {
      ...(after === undefined ? {} : { afterWriting: after as string[] }),
      ...(quick ? { priceWithinMs: AUTORUN_NOTICE_PRICE_MS } : {}),
    });
    if (!out) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ autoRuns: out, dailyLimit: dailyLimitView(req.userId!) });
  } catch (error) {
    console.error('Auto-run estimate error:', error);
    res.status(500).json({ error: 'Failed to estimate auto-run' });
  }
});

export default router;
