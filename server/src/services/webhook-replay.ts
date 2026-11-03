// "Add again": a delivery from a sheet's webhook log goes in once more as a new
// row, read with the webhook's mappings as they are now (after fixing one, say),
// through the same append as an arrival: the row cap, auto-dedupe (keeping the
// oldest, the new row isn't kept; keeping the newest, it replaces the earlier
// row with its key, which goes to the trash: the answer and History say so),
// the delivery log (the new delivery names the one it repeats). Not an arrival:
// the webhook's counters stay, and no Idempotency-Key applies. Works while the
// webhook is off: the person asked for this row.
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { getSourceForSheet } from '../lib/webhook-service';
import { appendWebhookDelivery, type WebhookMappingRow } from '../lib/webhook-ingest';
import { countOf, logSheetChange } from '../lib/change-log';

export type ReplayOutcome =
  | { ok: { rowIndex: number; status: 'stored' | 'partial' | 'duplicate'; replaced: number } }
  | { fail: 'not_found' | 'conflict'; message: string };

export function replayDelivery(userId: string, sheetId: string, deliveryId: string): ReplayOutcome {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const source = getSourceForSheet(sheetId, userId);
  if (!source) return { fail: 'not_found', message: 'This sheet has no webhook.' };
  const d = db.prepare(`SELECT id, payload, payload_bytes, status, received_at FROM webhook_deliveries
    WHERE id = ? AND source_id = ? AND user_id = ?`).get(deliveryId, source.id, userId) as
    { id: string; payload: string; payload_bytes: number; status: string; received_at: string } | undefined;
  if (!d) return { fail: 'not_found', message: 'That delivery isn\'t in this webhook\'s log.' };
  let payload: unknown;
  const kept = d.status !== 'pruned' && d.payload_bytes > 0;
  try { payload = kept ? JSON.parse(d.payload) : undefined; } catch { /* below */ }
  if (payload === undefined) {
    return { fail: 'conflict', message: 'This delivery\'s payload is no longer kept, so it can\'t be added again.' };
  }
  const mappings = db.prepare('SELECT json_path, column_name, value_mode FROM webhook_mappings WHERE source_id = ?')
    .all(source.id) as WebhookMappingRow[];
  const result = appendWebhookDelivery(source, mappings, payload, d.payload, { replayOf: d.id });
  if (!result.ok) return { fail: result.code === 404 ? 'not_found' : 'conflict', message: result.reason };
  if (result.status === 'repeat') return { fail: 'conflict', message: 'Nothing was added.' }; // no key: never
  const what = result.status === 'duplicate' ? ": auto-dedupe didn't keep it"
    : result.replaced > 0 ? `: it replaced ${countOf(result.replaced, 'row')} with the same key (auto-dedupe)` : '';
  logSheetChange(sheetId, userId, 'webhook', `Added a webhook delivery from ${d.received_at} UTC again${what}`,
    { detail: { delivery_id: d.id, row_index: result.rowIndex, status: result.status, replaced: result.replaced } });
  return { ok: { rowIndex: result.rowIndex, status: result.status, replaced: result.replaced } };
}
