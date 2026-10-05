import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { extractOutcome } from './jsonpath-extract';
import { pruneDeliveries } from './webhook-prune';
import { stripControlChars, clampCellChars } from './csv-safety';
import { MAX_ROWS_PER_SHEET, WEBHOOK_MAX_CELL_CHARS, WEBHOOK_MAX_ROW_DATA_BYTES } from './constants';
import { nextRowIndex } from './sheet-busy';
import { appendColumnsToOrder, getSheetColumns } from './sheet-columns';

// The append transaction for one inbound webhook delivery. This is the only
// place an UNAUTHENTICATED request mutates your data, so every step is
// scoped to the source's (user_id, sheet_id) and wrapped in ONE BEGIN IMMEDIATE
// transaction. See docs/webhooks.md.

export interface WebhookSourceRow {
  id: string;
  user_id: string;
  sheet_id: string;
  enabled: number;
  raw_column_name: string;
  store_raw_mode: string;
  total_received: number;
}

export interface WebhookMappingRow {
  json_path: string;
  column_name: string;
  value_mode: string; // 'scalar' | 'json'
}

export type IngestResult =
  | { ok: true; rowIndex: number; status: 'stored' | 'partial' }
  | { ok: false; code: 409; reason: string };

// Turn an extracted JSONPath value into the string that lands in a cell.
// missing/null -> ''; scalar -> stringified; object/array -> '' unless the
// mapping opted into value_mode='json' (compact JSON). Then truncate.
export function valueToCell(value: unknown, valueMode: string): string {
  if (value === null || value === undefined) return '';
  const t = typeof value;
  let out: string;
  if (t === 'string') out = value as string;
  else if (t === 'number' || t === 'boolean') out = String(value);
  else if (valueMode === 'json') out = JSON.stringify(value);
  else out = ''; // object/array without json mode -> blank
  // Strip control chars BEFORE truncation (same input policy as cell edits + CSV
  // import; csv-safety.ts) so a stripped char can't consume the cell budget. The
  // one input path that previously let NUL/C1 controls into rows.data (P2-9).
  // JSON-mode is a no-op (JSON.stringify never emits raw controls); tab/newline
  // are preserved.
  out = stripControlChars(out);
  // clampCellChars (basic tier — WEBHOOK_MAX_CELL_CHARS === CELL_MAX_BASIC) is
  // surrogate-safe, unlike the previous raw slice which could leave a lone
  // surrogate at the boundary (fable review). Marker kept inside the budget.
  return clampCellChars(out, WEBHOOK_MAX_CELL_CHARS);
}

// Build the new row's data object from the source's mappings against the parsed
// payload. Collects a per-mapping extraction error WITHOUT failing the append —
// the row is still created (the marker column + any resolvable cells). Returns
// the cell map and whether any mapping errored (-> delivery status 'partial').
function buildRowData(
  payload: unknown,
  mappings: WebhookMappingRow[],
  rawColumnName: string,
  storeRawMode: string,
  receivedAt: string,
): { data: Record<string, string>; partial: boolean; errorMessage: string | null } {
  const data: Record<string, string> = {};
  const errors: string[] = [];

  // The visible system marker column (read-only in the grid). 'none' mode leaves
  // it blank; 'marker' stamps a compact receipt time the renderer can show.
  if (storeRawMode !== 'none') {
    data[rawColumnName] = `📥 ${receivedAt}`;
  }

  // Per-delivery row-data byte budget (security: a sender hitting many wide
  // mappings could otherwise write ~625 KB/row and bloat the SQLite file). Track the
  // running serialized size; once a cell would push the row past the cap, stop
  // adding mapped cells. The ROW is still created (the marker + any cells that
  // fit) — never silently dropped — and the delivery is flagged 'partial'.
  let budget = WEBHOOK_MAX_ROW_DATA_BYTES - Buffer.byteLength(JSON.stringify(data), 'utf8');
  let truncatedForSize = false;

  for (const m of mappings) {
    // extractOutcome distinguishes "no match" (blank cell, normal) from a
    // malformed-path THROW. A throw never fails the append — the cell is left
    // blank and the delivery is flagged 'partial' with a redacted reason — but
    // a plain no-match is NOT an error (the field just wasn't in this payload).
    const out = extractOutcome(payload, m.json_path);
    let cell: string;
    if (out.error) {
      cell = '';
      errors.push(`${m.column_name}: ${out.error}`);
    } else {
      cell = valueToCell(out.value, m.value_mode);
    }
    // Cost of adding this cell to the JSON object (key + value + quoting/comma).
    const cost = Buffer.byteLength(JSON.stringify({ [m.column_name]: cell }), 'utf8');
    if (cell.length > 0 && cost > budget) {
      // Doesn't fit — leave the cell blank rather than blow the row-byte cap.
      data[m.column_name] = '';
      truncatedForSize = true;
      continue;
    }
    data[m.column_name] = cell;
    budget -= cost;
  }

  if (truncatedForSize) errors.push('row exceeded the size limit; some cells were dropped');
  const errorMessage = errors.length > 0 ? errors.join('; ').slice(0, 500) : null;
  return { data, partial: errors.length > 0, errorMessage };
}

// Append one delivery for `source`. Caller has already validated the token,
// passed the rate limiter, parsed + shape-checked the payload. `rawPayloadText`
// is the original request body text (capped upstream). Synchronous, one
// IMMEDIATE transaction; better-sqlite3 serializes concurrent deliveries.
export function appendWebhookDelivery(
  source: WebhookSourceRow,
  mappings: WebhookMappingRow[],
  payload: unknown,
  rawPayloadText: string,
): IngestResult {
  const receivedClock = new Date().toISOString().slice(11, 19); // HH:MM:SS for the marker
  const { data, partial, errorMessage } = buildRowData(
    payload, mappings, source.raw_column_name, source.store_raw_mode, receivedClock,
  );
  const payloadBytes = Buffer.byteLength(rawPayloadText, 'utf8');
  const payloadSha = crypto.createHash('sha256').update(rawPayloadText).digest('hex');
  const dataJson = JSON.stringify(data);

  let result: IngestResult = { ok: true, rowIndex: -1, status: partial ? 'partial' : 'stored' };

  db.transaction(() => {
    // Row cap inside the txn so a burst can't push a sheet past its row limit.
    const { rows: currentRows } = countRows(source.sheet_id, source.user_id);
    if (currentRows >= MAX_ROWS_PER_SHEET) {
      result = { ok: false, code: 409, reason: 'Sheet is full' };
      return;
    }

    // Single allocator (lib/sheet-busy.ts), the same as the addRows endpoint, so
    // an open tab and the webhook can't collide, and a delivery that arrives
    // mid-sort or mid-import lands after that operation's rows.
    // (UNIQUE(sheet_id, user_id, row_index) backstops.)
    const rowIndex = nextRowIndex(source.sheet_id, source.user_id);
    const rowId = uuidv4();

    db.prepare(
      `INSERT INTO rows (id, sheet_id, user_id, row_index, data, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(rowId, source.sheet_id, source.user_id, rowIndex, dataJson);

    // A column exists iff column_order lists it (lib/sheet-columns.ts). The
    // webhook's columns were listed when it was set up, but a CSV replace can
    // unlist them since; list any that are missing so the values stay visible.
    // Reads one JSON array, never the rows.
    const listed = new Set(getSheetColumns(source.sheet_id, source.user_id));
    const unlisted = Object.keys(data).filter(k => !listed.has(k));
    if (unlisted.length > 0) appendColumnsToOrder(source.sheet_id, source.user_id, unlisted);

    db.prepare(
      `INSERT INTO webhook_deliveries
         (id, source_id, user_id, sheet_id, row_id, payload, payload_sha256, payload_bytes, status, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuidv4(), source.id, source.user_id, source.sheet_id, rowId,
      rawPayloadText, payloadSha, payloadBytes, partial ? 'partial' : 'stored', errorMessage,
    );

    pruneDeliveries(source.id);

    // Counters + first-event masking: nulling token_ciphertext on the first
    // delivery makes the secret hash-only (unrecoverable) from now on.
    db.prepare(
      `UPDATE webhook_sources
          SET total_received = total_received + 1,
              last_received_at = datetime('now'),
              token_ciphertext = NULL,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(source.id);

    // data_version: the live-update signal for an open grid, so new rows appear
    // without a reload. Do NOT bump row_generation: an
    // append doesn't change what any existing row_index means.
    db.prepare(
      `UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`,
    ).run(source.sheet_id, source.user_id);

    result = { ok: true, rowIndex, status: partial ? 'partial' : 'stored' };
  }).immediate();

  return result;
}

function countRows(sheetId: string, userId: string): { rows: number } {
  const r = db.prepare(
    'SELECT COUNT(*) AS n FROM rows WHERE sheet_id = ? AND user_id = ?',
  ).get(sheetId, userId) as { n: number };
  return { rows: r.n };
}
