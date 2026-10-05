import { db } from './db';
import {
  WEBHOOK_RAW_KEEP_COUNT, WEBHOOK_RAW_KEEP_BYTES, WEBHOOK_DELIVERY_KEEP_COUNT,
} from './constants';

// Raw-payload retention. Prunes a source's stored raw JSON down to BOTH bounds
// (newest WEBHOOK_RAW_KEEP_COUNT AND <= WEBHOOK_RAW_KEEP_BYTES), whichever is
// smaller. Runs inside the append transaction.
//
// IMPORTANT: pruning NULLS the stored raw payload but KEEPS the delivery row.
// The appended spreadsheet row always stays (mapped columns persist forever); we
// only drop the heavy raw JSON. Keeping the delivery row (with row_id + metadata)
// lets the raw-view distinguish "this row had a webhook delivery whose raw is no
// longer retained" from "no delivery at all" — the design's "raw no longer
// retained" state. A pruned delivery has payload='' and payload_bytes=0.

const PRUNED = ''; // sentinel: payload dropped, row kept

// Mark a set of deliveries as pruned (clear payload + zero the byte count, keep
// the row + metadata). status becomes 'pruned' so the raw-view can report it.
function clearPayloads(ids: string[]): void {
  if (ids.length === 0) return;
  const clear = db.prepare(
    `UPDATE webhook_deliveries SET payload = ?, payload_bytes = 0, status = 'pruned' WHERE id = ?`,
  );
  for (const id of ids) clear.run(PRUNED, id);
}

export function pruneDeliveries(sourceId: string): void {
  // Count cap: clear payloads on everything OLDER than the newest N that still
  // holds a payload (payload_bytes > 0 == not already pruned).
  const overCount = db.prepare(
    `SELECT id FROM webhook_deliveries
       WHERE source_id = ? AND payload_bytes > 0
         AND id NOT IN (
           SELECT id FROM webhook_deliveries
             WHERE source_id = ? AND payload_bytes > 0
             ORDER BY received_at DESC, id DESC LIMIT ?
         )`,
  ).all(sourceId, sourceId, WEBHOOK_RAW_KEEP_COUNT) as Array<{ id: string }>;
  clearPayloads(overCount.map(r => r.id));

  // Byte cap: walk the still-retained payloads newest-first, clear once the
  // running sum exceeds the limit. Bounded by WEBHOOK_RAW_KEEP_COUNT rows.
  const retained = db.prepare(
    `SELECT id, payload_bytes FROM webhook_deliveries
       WHERE source_id = ? AND payload_bytes > 0
       ORDER BY received_at DESC, id DESC`,
  ).all(sourceId) as Array<{ id: string; payload_bytes: number }>;
  let sum = 0;
  const overBytes: string[] = [];
  for (const r of retained) {
    sum += r.payload_bytes;
    if (sum > WEBHOOK_RAW_KEEP_BYTES) overBytes.push(r.id);
  }
  clearPayloads(overBytes);

  // Lifetime row cap: hard-DELETE delivery ROWS (metadata + all) beyond the newest
  // WEBHOOK_DELIVERY_KEEP_COUNT for this source. Payload-pruning above keeps rows
  // forever, so without this a fill/delete/repeat cycle grows the table without
  // bound. Deleting only affects the delivery LOG; the appended spreadsheet rows
  // are unaffected (rows.id ON DELETE SET NULL is on the deliveries side).
  db.prepare(
    `DELETE FROM webhook_deliveries
       WHERE source_id = ? AND id NOT IN (
         SELECT id FROM webhook_deliveries WHERE source_id = ?
         ORDER BY received_at DESC, id DESC LIMIT ?
       )`,
  ).run(sourceId, sourceId, WEBHOOK_DELIVERY_KEEP_COUNT);
}
