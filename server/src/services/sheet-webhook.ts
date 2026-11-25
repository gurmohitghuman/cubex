// Over 200 lines: one service for every action on a sheet's webhook, which the app, REST and MCP all call.
//
// A sheet's incoming webhook (docs/webhooks.md): one service for the app's Webhook drawer
// (routes/sheets-webhooks.ts, cookie session), /api/v1/sheets/:id/webhook (routes/api-v1-sheet-webhook.ts)
// and the manage_sheet_webhook tool (mcp/tools-sheet-webhook.ts), so the three can't drift: each checks the
// sheet is the caller's and not in the trash, makes the change and writes it to the sheet's History. Only
// the answer's shape differs: the app keeps its own (serializeSource), the API and MCP get sheetWebhookView.
//
// Who may see the URL (Gurmohit, 2026-11-06): whoever may change the sheet. Over the API that is the 'write'
// scope; a 'read' token sees the state without it. The URL is shown only until the first event arrives
// (lib/webhook-token.ts); after that, rotating is the way to a new one.
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { logSheetChange } from '../lib/change-log';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import { dropWebhookBucket } from '../lib/webhook-bucket';
import { generateWebhookAuthToken, revealWebhookSecret } from '../lib/webhook-token';
import {
  createSourceWithColumn, getSourceForSheet, listMappings, rotateSource, webhookUrlForSecret,
  type WebhookSourceFull,
} from '../lib/webhook-service';
import { addWebhookMapping } from './webhook-mapping-add';

export type SheetWebhookFail = { fail: 'bad_request' | 'not_found' | 'conflict'; message: string; busy?: true };
export type SheetWebhookOutcome<T> = { ok: T } | SheetWebhookFail;

const SHEET_NOT_FOUND: SheetWebhookFail = { fail: 'not_found', message: 'Sheet not found' };
const NO_WEBHOOK: SheetWebhookFail = { fail: 'not_found', message: 'No webhook on this sheet.' };

// A field the webhook fills: the value at json_path in each event goes into column, as text or as JSON.
export interface SheetWebhookField {
  id: string; json_path: string; column: string; as: 'text' | 'json'; created_at: string;
}

export interface SheetWebhookView {
  id: string;
  sheet_id: string;
  enabled: boolean;
  // The address senders POST to. null when it can't be shown: after the first event, or to a read-only key.
  url: string | null;
  // true once an event has arrived: the URL is never shown again, and rotate makes a new one.
  url_hidden: boolean;
  // Senders must send its token as Authorization: Bearer <token>; without it an event gets 404. The token
  // itself is shown once, when it is made (new_token).
  token_required: boolean;
  token_set_at: string | null;
  // The column that marks the rows the webhook added (open a cell for its raw event).
  column: string;
  events_received: number;
  last_event_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  rotated_at: string | null;
  fields: SheetWebhookField[];
}

// The API's and MCP's view of a source. base: where the caller reached Cubex (lib/file-links.ts linkBase),
// so the url is absolute, ready to paste into a sender; null: the caller may not see it (no 'write').
export function sheetWebhookView(src: WebhookSourceFull, base: string | null): SheetWebhookView {
  const secret = base !== null && src.token_ciphertext ? revealWebhookSecret(src.token_ciphertext) : null;
  return {
    id: src.id,
    sheet_id: src.sheet_id,
    enabled: src.enabled === 1,
    url: secret ? webhookUrlForSecret(secret, base!) : null,
    url_hidden: !src.token_ciphertext,
    token_required: !!src.auth_token_hash,
    token_set_at: src.auth_token_set_at,
    column: src.raw_column_name,
    events_received: src.total_received,
    last_event_at: src.last_received_at,
    last_error: src.last_error_message,
    last_error_at: src.last_error_at,
    created_at: src.created_at,
    rotated_at: src.rotated_at,
    fields: listMappings(src.id).map(m => ({
      id: m.id, json_path: m.jsonPath, column: m.columnName, as: m.valueMode === 'json' ? 'json' : 'text',
      created_at: m.createdAt,
    })),
  };
}

// The sheet (the caller's, not in the trash) and its webhook, or why not.
function sourceOf(userId: string, sheetId: string): SheetWebhookOutcome<WebhookSourceFull> {
  if (!verifySheetOwnership(sheetId, userId)) return SHEET_NOT_FOUND;
  const src = getSourceForSheet(sheetId, userId);
  return src ? { ok: src } : NO_WEBHOOK;
}

const reread = (src: WebhookSourceFull): WebhookSourceFull => getSourceForSheet(src.sheet_id, src.user_id)!;

// The sheet's webhook, or null when it has none.
export function getSheetWebhook(userId: string, sheetId: string): SheetWebhookOutcome<WebhookSourceFull | null> {
  if (!verifySheetOwnership(sheetId, userId)) return SHEET_NOT_FOUND;
  return { ok: getSourceForSheet(sheetId, userId) };
}

// Gives the sheet its webhook (one per sheet) and the column that marks the rows it adds. No row is touched,
// so it costs the same on a million-row sheet as on an empty one (lib/webhook-service.ts).
export function createSheetWebhook(
  userId: string, sheetId: string, rawName?: unknown,
): SheetWebhookOutcome<WebhookSourceFull> {
  if (!verifySheetOwnership(sheetId, userId)) return SHEET_NOT_FOUND;
  if (getSourceForSheet(sheetId, userId)) return { fail: 'conflict', message: 'This sheet already has a webhook.' };
  // The routers refuse a busy sheet too, but MCP's create with a table or sheet, and Express between its
  // routers, can reach here after a sort or an import started: adding the column waits for it.
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy), busy: true };
  if (getSheetColumns(sheetId, userId).length >= MAX_COLUMNS_PER_SHEET) {
    return { fail: 'bad_request', message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet).` };
  }
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 100) : 'Webhook';
  const { source } = createSourceWithColumn(sheetId, userId, name);
  logSheetChange(sheetId, userId, 'webhook', 'Added a webhook to the sheet');
  return { ok: source };
}

// Turns the webhook on or off. While off, events get the generic 404 and add nothing.
export function setSheetWebhookEnabled(
  userId: string, sheetId: string, enabled: unknown,
): SheetWebhookOutcome<WebhookSourceFull> {
  const found = sourceOf(userId, sheetId);
  if ('fail' in found) return found;
  if (typeof enabled !== 'boolean') return { fail: 'bad_request', message: 'enabled (true or false) is required.' };
  db.prepare("UPDATE webhook_sources SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
    .run(enabled ? 1 : 0, found.ok.id);
  logSheetChange(sheetId, userId, 'webhook', `Turned the webhook ${enabled ? 'on' : 'off'}`);
  return { ok: reread(found.ok) };
}

// A new URL, shown until its first event; the old one stops at once.
export function rotateSheetWebhook(userId: string, sheetId: string): SheetWebhookOutcome<WebhookSourceFull> {
  const found = sourceOf(userId, sheetId);
  if ('fail' in found) return found;
  rotateSource(found.ok);
  logSheetChange(sheetId, userId, 'webhook', 'Made a new webhook URL (the old one stopped working)');
  return { ok: reread(found.ok) };
}

// A new token senders must send (Authorization: Bearer <token>), replacing any it had: an event without it, or
// with the old one, gets the generic 404 from now on. The token is in the answer, the only time it is shown;
// only its hash is kept.
export function newSheetWebhookToken(
  userId: string, sheetId: string,
): SheetWebhookOutcome<{ source: WebhookSourceFull; token: string }> {
  const found = sourceOf(userId, sheetId);
  if ('fail' in found) return found;
  const { token, tokenHash } = generateWebhookAuthToken();
  db.prepare(`UPDATE webhook_sources SET auth_token_hash = ?, auth_token_set_at = datetime('now'),
    updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(tokenHash, found.ok.id, userId);
  logSheetChange(sheetId, userId, 'webhook', found.ok.auth_token_hash
    ? 'Made a new webhook token (the old one stopped working)' : 'Made the webhook need a token');
  return { ok: { source: reread(found.ok), token } };
}

// Senders no longer need a token: anyone with the URL can add rows again. Nothing to do when it has none.
export function removeSheetWebhookToken(userId: string, sheetId: string): SheetWebhookOutcome<WebhookSourceFull> {
  const found = sourceOf(userId, sheetId);
  if ('fail' in found) return found;
  if (!found.ok.auth_token_hash) return { ok: found.ok };
  db.prepare(`UPDATE webhook_sources SET auth_token_hash = NULL, auth_token_set_at = NULL,
    updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(found.ok.id, userId);
  logSheetChange(sheetId, userId, 'webhook', 'Removed the webhook token (anyone with the URL can add rows)');
  return { ok: reread(found.ok) };
}

// Removes the webhook, its fields and its kept events. The columns it filled and their rows stay; the marker
// column can then be deleted like any other.
export function deleteSheetWebhook(userId: string, sheetId: string): SheetWebhookOutcome<true> {
  const found = sourceOf(userId, sheetId);
  if ('fail' in found) return found;
  db.prepare('DELETE FROM webhook_sources WHERE id = ? AND user_id = ?').run(found.ok.id, userId);
  dropWebhookBucket(found.ok.id); // free the per-source rate-limit bucket
  logSheetChange(sheetId, userId, 'webhook', 'Deleted the webhook');
  return { ok: true };
}

// A new field: each event's value at jsonPath goes into a new column (services/webhook-mapping-add.ts).
export function addSheetWebhookField(
  userId: string, sheetId: string, input: { jsonPath: unknown; column: unknown; asJson: boolean },
): SheetWebhookOutcome<{ source: WebhookSourceFull; column: string }> {
  const found = sourceOf(userId, sheetId);
  if ('fail' in found) return found;
  const out = addWebhookMapping(sheetId, userId, found.ok.id, {
    jsonPath: typeof input.jsonPath === 'string' ? input.jsonPath.trim() : '',
    columnName: typeof input.column === 'string' ? input.column : '',
    valueMode: input.asJson ? 'json' : 'scalar',
  });
  if ('fail' in out) {
    return out.fail === 'busy'
      ? { fail: 'conflict', message: out.error, busy: true } : { fail: 'bad_request', message: out.error };
  }
  return { ok: { source: found.ok, column: out.column } };
}

// Stops filling a field. Its column and the values already in it stay.
export function removeSheetWebhookField(
  userId: string, sheetId: string, fieldId: unknown,
): SheetWebhookOutcome<WebhookSourceFull> {
  const found = sourceOf(userId, sheetId);
  if ('fail' in found) return found;
  const r = typeof fieldId === 'string'
    ? db.prepare('DELETE FROM webhook_mappings WHERE id = ? AND source_id = ? AND user_id = ?')
      .run(fieldId, found.ok.id, userId)
    : { changes: 0 };
  if (r.changes === 0) return { fail: 'not_found', message: 'Field not found.' };
  logSheetChange(sheetId, userId, 'webhook', 'Removed a field the webhook filled (its column stays)');
  return { ok: found.ok };
}

// Create with a table or sheet (webhook: true on manage_table / manage_sheet create and their REST routes):
// the new, empty sheet gets its webhook in the same call. The sheet is already made, so a refusal here
// (none is expected on a new sheet) comes back as webhook_error beside it rather than undoing it.
export function webhookForNewSheet(
  userId: string, sheetId: string, base: string,
): { webhook: SheetWebhookView } | { webhook_error: string } {
  const out = createSheetWebhook(userId, sheetId);
  return 'fail' in out ? { webhook_error: out.message } : { webhook: sheetWebhookView(out.ok, base) };
}

// webhook on a create: true, false or left out.
export const webhookFlagProblem = (v: unknown): string | null =>
  (v === undefined || typeof v === 'boolean' ? null : 'webhook is true or false.');
