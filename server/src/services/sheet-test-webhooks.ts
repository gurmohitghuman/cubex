// Adding the webhook deliveries a sheet kept while it was tested (lib/webhook-hold.ts): oldest first, each in its
// own transaction through the same append as an arrival (the row cap, auto-dedupe, the webhook's mappings as they
// are now), a slice at a time between other requests. A new delivery waits behind them meanwhile, so the order
// holds. Stops while the sheet is tested again; one refused (the sheet full, or gone) says why in the delivery log.
// Started when a test ends, and at boot for every sheet still holding some.
import { db } from '../lib/db';
import { HEAVY_JOB_RETRY_MAX_MS, HEAVY_JOB_RETRY_MS } from '../lib/constants';
import { sheetUnderTest } from '../lib/sheet-test-hold';
import { getSourceForSheet } from '../lib/webhook-service';
import { appendWebhookDelivery, type WebhookMappingRow } from '../lib/webhook-ingest';
import { runInCheckpointedSlices } from '../lib/bulk-slices';

const SLICE = 50;
const draining = new Set<string>();

function addOne(sheetId: string, userId: string, d: { id: string; payload: string }): void {
  const source = getSourceForSheet(sheetId, userId);
  const fail = (why: string) => db.prepare(`UPDATE webhook_deliveries SET status = 'error', error_message = ?
    WHERE id = ? AND status = 'held'`).run(why, d.id);
  if (!source) { fail('Its webhook was deleted.'); return; }
  let payload: unknown;
  try { payload = JSON.parse(d.payload); } catch { fail('Its body was not JSON.'); return; }
  const mappings = db.prepare('SELECT json_path, column_name, value_mode FROM webhook_mappings WHERE source_id = ?')
    .all(source.id) as WebhookMappingRow[];
  const out = appendWebhookDelivery(source, mappings, payload, d.payload, { heldId: d.id });
  if (!out.ok) fail(out.code === 404 ? 'Its sheet was deleted.' : out.reason);
}

// A slice of them a transaction, through the bulk writers' runner (lib/bulk-slices.ts: its WAL copied back off
// this thread, requests answered between slices).
async function drain(sheetId: string, userId: string): Promise<void> {
  const next = db.prepare(`SELECT id, payload FROM webhook_deliveries WHERE sheet_id = ? AND status = 'held'
    ORDER BY rowid LIMIT ?`);
  await runInCheckpointedSlices(() => {
    if (sheetUnderTest(sheetId)) return false;
    const batch = next.all(sheetId, SLICE) as Array<{ id: string; payload: string }>;
    for (const d of batch) addOne(sheetId, userId, d);
    return batch.length === SLICE;
  });
}

// Adds them in the background (once per sheet at a time), trying again after a failure, waiting longer each time.
export function addHeldDeliveries(sheetId: string, userId: string): void {
  if (draining.has(sheetId)) return;
  draining.add(sheetId);
  void (async () => {
    for (let wait = HEAVY_JOB_RETRY_MS; ; wait = Math.min(wait * 2, HEAVY_JOB_RETRY_MAX_MS)) {
      try { await drain(sheetId, userId); break; }
      catch (err) { console.error(`Adding the kept webhook deliveries of sheet ${sheetId} failed, retrying:`, err); }
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    draining.delete(sheetId);
  })();
}

// At boot: every sheet holding deliveries and not being tested.
export function resumeHeldDeliveries(): void {
  const sheets = db.prepare(`SELECT DISTINCT d.sheet_id, d.user_id FROM webhook_deliveries d
    WHERE d.status = 'held' AND NOT EXISTS (SELECT 1 FROM sheet_tests t WHERE t.sheet_id = d.sheet_id
      AND t.state = 'open')`).all() as Array<{ sheet_id: string; user_id: string }>;
  for (const s of sheets) addHeldDeliveries(s.sheet_id, s.user_id);
}
