// manage_sheet_webhook: a sheet's incoming webhook (services/sheet-webhook.ts, the same service as the app's
// Webhook drawer and /api/v1/sheets/:id/webhook). One action-enum'd tool, as manage_sheet is, to keep the
// tool list short. get needs 'read' and shows the URL only to a key with 'write'; every other action needs
// 'write' (Gurmohit, 2026-11-06: whoever may change the sheet may see and rotate its URL).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import {
  addSheetWebhookField, createSheetWebhook, deleteSheetWebhook, getSheetWebhook, newSheetWebhookToken,
  removeSheetWebhookAutoDelete, removeSheetWebhookField, removeSheetWebhookToken, rotateSheetWebhook,
  setSheetWebhookAutoDelete, setSheetWebhookEnabled, sheetWebhookView, type SheetWebhookOutcome,
} from '../services/sheet-webhook';
import type { WebhookSourceFull } from '../lib/webhook-service';
import { McpAuthCtx, ok, err, missingScope, registerTool, SHEET_ID, mcpLinkBase } from './tool-helpers';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import { changedOf } from './changed';
import { AUTO_DELETE_KEEP_DEFAULT, AUTO_DELETE_KEEP_MAX } from '../lib/constants-webhook-auto-delete';
import { GUIDE_POINTER } from './guides/guide';

const ACTIONS = [
  'get', 'create', 'turn_on', 'turn_off', 'rotate', 'add_field', 'remove_field', 'new_token', 'remove_token',
  'set_auto_delete', 'auto_delete_off', 'delete',
] as const;

export function registerSheetWebhookTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'manage_sheet_webhook', {
    description:
      'A sheet\'s incoming webhook: a secret URL where each JSON event POSTed becomes a new row. create: '
      + 'adds one (one per sheet) and a column marking the rows it adds. The url is shown until the first event '
      + 'arrives, and only to a key with the write scope; after that it is hidden and rotate makes a new one (the '
      + 'old one stops at once). delete: the webhook and its kept events go; its '
      + 'columns and rows stay. new_token: senders must then send the answer\'s token (shown once) as '
      + 'Authorization: Bearer <token>, or get 404; an old one stops. set_auto_delete: keep the newest keep_rows '
      + `rows (default ${AUTO_DELETE_KEEP_DEFAULT}); older rows the webhook added are deleted, not to the trash `
      + '(they can\'t be restored), once every auto-run column has run on them and, with success_column, once it '
      + 'has a result; with copy_to_sheet_id they are copied there first. auto_delete_off stops it. Every action '
      + `but get needs the write scope. ${GUIDE_POINTER}`,
    inputSchema: z.object({
      action: z.enum(ACTIONS).describe('What to do'),
      sheet_id: z.string().describe(SHEET_ID),
      json_path: z.string().optional().describe('add_field: where the value is in each event, like $.email'),
      column: z.string().optional().describe('add_field: the new column\'s name'),
      as: z.enum(['text', 'json']).optional().describe('add_field: text (default) or the value as JSON'),
      field_id: z.string().optional().describe('remove_field: the field (get lists them)'),
      keep_rows: z.number().int().optional()
        .describe(`set_auto_delete: newest rows kept, 0 to ${AUTO_DELETE_KEEP_MAX}`),
      success_column: z.string().nullable().optional()
        .describe('set_auto_delete: rows leave once this column has a result'),
      copy_to_sheet_id: z.string().nullable().optional()
        .describe('set_auto_delete: copy rows to this sheet before they leave'),
    }).strict(),
  }, async ({ action, sheet_id, json_path, column, as, field_id, keep_rows, success_column, copy_to_sheet_id }) => {
    const denied = missingScope(ctx, action === 'get' ? 'read' : 'write');
    if (denied) return denied;
    const addOnly = json_path !== undefined || column !== undefined || as !== undefined;
    if (addOnly && action !== 'add_field') return err('json_path, column and as are for add_field.');
    if (field_id !== undefined && action !== 'remove_field') return err('field_id is for remove_field.');
    const autoDelete = keep_rows !== undefined || success_column !== undefined || copy_to_sheet_id !== undefined;
    if (autoDelete && action !== 'set_auto_delete') {
      return err('keep_rows, success_column and copy_to_sheet_id are for set_auto_delete.');
    }

    if (action === 'get') {
      const got = getSheetWebhook(ctx.userId, sheet_id);
      if ('fail' in got) return err(got.message);
      return ok({ webhook: got.ok && sheetWebhookView(got.ok, ctx.scopes.has('write') ? mcpLinkBase(ctx) : null),
        changed: [] });
    }
    // get reads while a sort or an import runs, as get_sheet does. Setting one up and adding or removing a field
    // change columns and wait, as over REST; the webhook's own controls (on, off, a new URL or token, auto-delete,
    // delete) go through, so a leaked URL can be cut off mid-import (lib/sheet-busy.ts webhookControl).
    const waits = action === 'create' || action === 'add_field' || action === 'remove_field';
    const busy = waits ? sheetBusyWith(sheet_id) : null;
    if (busy) return err(busyMessage(busy));
    if (action === 'delete') {
      const gone = deleteSheetWebhook(ctx.userId, sheet_id);
      return 'fail' in gone ? err(gone.message) : ok({ deleted: true, changed: [] });
    }
    // The columns a create or add_field adds to the sheet, for changed.
    const answer = (out: SheetWebhookOutcome<WebhookSourceFull>, added?: string) => {
      if ('fail' in out) return err(out.message);
      return ok({
        webhook: sheetWebhookView(out.ok, mcpLinkBase(ctx)),
        changed: added ? changedOf(ctx.userId, [{ sheetId: sheet_id, columns: [added] }]) : [],
      });
    };
    if (action === 'create') {
      const made = createSheetWebhook(ctx.userId, sheet_id);
      return answer(made, 'fail' in made ? undefined : made.ok.raw_column_name);
    }
    if (action === 'turn_on' || action === 'turn_off') {
      return answer(setSheetWebhookEnabled(ctx.userId, sheet_id, action === 'turn_on'));
    }
    if (action === 'rotate') return answer(rotateSheetWebhook(ctx.userId, sheet_id));
    if (action === 'new_token') {
      const made = newSheetWebhookToken(ctx.userId, sheet_id);
      if ('fail' in made) return err(made.message);
      return ok({ webhook: sheetWebhookView(made.ok.source, mcpLinkBase(ctx)), token: made.ok.token, changed: [] });
    }
    if (action === 'remove_token') return answer(removeSheetWebhookToken(ctx.userId, sheet_id));
    if (action === 'set_auto_delete') {
      return answer(setSheetWebhookAutoDelete(ctx.userId, sheet_id, { keep_rows, success_column, copy_to_sheet_id }));
    }
    if (action === 'auto_delete_off') return answer(removeSheetWebhookAutoDelete(ctx.userId, sheet_id));
    if (action === 'add_field') {
      if (!json_path || !column) return err('add_field needs json_path and column.');
      const added = addSheetWebhookField(ctx.userId, sheet_id, { jsonPath: json_path, column, asJson: as === 'json' });
      if ('fail' in added) return err(added.message);
      return answer({ ok: added.ok.source }, added.ok.column);
    }
    if (!field_id) return err('remove_field needs field_id (get lists them).');
    return answer(removeSheetWebhookField(ctx.userId, sheet_id, field_id));
  });
}
