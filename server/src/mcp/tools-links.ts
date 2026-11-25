// create_upload_link / create_download_link: a CSV file of any size into or out
// of a sheet, from any machine that can reach Cubex, without its contents
// passing through the agent's context. The agent gets a one-time link
// (lib/file-links.ts) and moves the file with the curl command that comes with
// it (routes/file-links.ts). Each needs only what the token can already do:
// write to import (as import_csv), read to export (as export_csv).
import { verifySheetOwnership } from '../lib/sql-helpers';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { planSheetExport } from '../lib/csv-export';
import { createFileLink, fileLinkUrl } from '../lib/file-links';
import { tooManyMessage } from '../lib/rate-window';
import { MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { FILE_LINK_TTL_MINUTES } from '../lib/api-v1-constants';
import { GARBLED_HELP, importWindow } from './tools-import';
import { SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { VIEW_HELP, whereLike } from './where-schema';
import { applyView } from '../services/view-read';
import type { WhereItem } from '../lib/row-filter/where';
import { RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import { prepareFileCall } from '../services/setup-call-file';
import { callInputOf } from '../services/setup-call-input';
import { setupCallSheet } from '../services/setup-call-view';

const MAX_MB = Math.round(MAX_CSV_UPLOAD_BYTES / (1024 * 1024));

// For a token without write: said up front in the tool list, and in full when
// the tool is called anyway, so the agent can tell the user what to change.
const NO_WRITE_NOTE = 'This token has no write permission, so this tool will refuse.';
const NO_WRITE = "This action requires the 'write' scope, which this Cubex access token doesn't have, "
  + 'so no link was made and nothing was imported. To import files, the user can create a token with '
  + 'Write ticked in Cubex (Settings, then Agent access) and connect with it, or import the file '
  + 'themselves: open the sheet in Cubex and click Import.';

export function registerLinkTools(server: McpServer, ctx: McpAuthCtx) {
  const base = ctx.linkBase ?? `http://localhost:${process.env.PORT || 3002}`;
  const canWrite = ctx.scopes.has('write');

  registerTool(server,
    'create_upload_link',
    {
      description:
        `Import a CSV file of any size (up to ${MAX_MB} MB) into a sheet without its contents passing through `
        + 'your context. Returns a one-time link; upload the file to it with the curl command in the result, '
        + 'from any machine that can reach Cubex. curl prints the import result (rows imported, new columns). '
        + GARBLED_HELP + ' '
        + 'Same header rules as import_csv; mode "replace" deletes all existing rows when the file arrives (to the '
        + `trash, restorable). The link works once and expires in ${FILE_LINK_TTL_MINUTES} minutes. Needs the write `
        + 'scope. With setup_id instead of sheet_id, the rows are a setup call\'s items (call_setup): it starts once '
        + 'the file is in, COSTS MONEY, and needs max_cost_usd and the run scope.'
        + (canWrite ? '' : ` ${NO_WRITE_NOTE}`),
      inputSchema: {
        sheet_id: z.string().optional().describe(`${SHEET_ID}. Or setup_id.`),
        mode: z.enum(['append', 'replace']).optional().describe('Default append'),
        setup_id: z.string().optional().describe('Or: call this setup on the file\'s rows'),
        max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional()
          .describe('With setup_id, required: the most it may cost, in dollars'),
        allow_unpriced: lenientBoolean().optional().describe('With setup_id: start a step with no known price'),
        models: z.record(z.string(), z.string()).optional().describe('With setup_id: AI step column -> model'),
        webhook_id: z.string().optional().describe('With setup_id: a run webhook to notify'),
      },
    },
    async ({ sheet_id, mode, setup_id, ...call }) => {
      if (!canWrite) return err(NO_WRITE);
      if (!sheet_id === !setup_id) return err('Pass sheet_id, or setup_id to call a setup on the file\'s rows.');
      if (setup_id) {
        const denied = missingScope(ctx, 'run');
        if (denied) return denied;
        if (mode === 'replace') return err('A setup call on a file adds its rows: leave mode out.');
      } else if (Object.values(call).some(v => v !== undefined)) {
        return err('max_cost_usd, allow_unpriced, models and webhook_id go with setup_id.');
      }
      if (sheet_id && !verifySheetOwnership(sheet_id, ctx.userId)) {
        return err('Sheet not found');
      }
      // Each link is one import, so it takes a slot from the same budget.
      const slot = importWindow(ctx.tokenId);
      if (!slot.allowed) return err(tooManyMessage('CSV imports', slot));
      const chosen = mode ?? 'append';
      let target = sheet_id ?? '';
      const options: Record<string, unknown> = { mode: chosen };
      if (setup_id) {
        const input = callInputOf({ ...call, estimate_only: false }, 'mcp');
        if ('fail' in input) return err(input.message);
        const prepared = prepareFileCall(ctx.userId, setup_id, input,
          { hasSecretsScope: ctx.scopes.has('secrets'), tokenId: ctx.tokenId });
        if ('fail' in prepared) return err(prepared.message);
        target = prepared.sheetId;
        options.call = prepared.call;
      }
      const link = createFileLink({
        userId: ctx.userId, tokenId: ctx.tokenId, sheetId: target, kind: 'upload', options,
      });
      const url = fileLinkUrl(base, 'upload', link.token);
      return ok({
        upload_url: url,
        curl: `curl -sS -T <file.csv> '${url}'`,
        mode: chosen,
        expires_at: link.expiresAt,
        max_mb: MAX_MB,
        note: 'Replace <file.csv> with the path to the file, and send the file itself (not from a pipe or as a '
          + 'form). The link works once; if an upload is refused, the reply says whether the link still works.',
      });
    },
  );

  registerTool(server,
    'create_download_link',
    {
      description:
        'Save a sheet, or the columns and rows you pick (as in export_csv), as a CSV file of any size without its '
        + 'contents passing through your context. Returns a one-time link; download it with the curl command in '
        + 'the result to save it anywhere on your machine, or give the link to the user to open in a browser. '
        + `The link works once and expires in ${FILE_LINK_TTL_MINUTES} minutes. Until then anyone who has it can `
        + 'download the data, so give it only to the user. The file holds the rows up to the last one the sheet '
        + 'had when the download begins. Values are escaped against spreadsheet formula injection. Or '
        + 'setup_call_id: a setup call\'s items.',
      inputSchema: {
        sheet_id: z.string().optional().describe(`${SHEET_ID}. Or setup_call_id.`),
        setup_call_id: z.string().optional().describe('Or: a setup call\'s items'),
        columns: z.array(z.string()).min(1).optional()
          .describe('Only these columns, in this order. Omit for every column.'),
        where: whereLike('Only the rows it passes.').optional(),
        view: z.string().min(1).optional().describe(VIEW_HELP),
      },
    },
    async ({ sheet_id: given, setup_call_id, columns, where, view }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      if (!given === !setup_call_id) return err('Pass sheet_id, or setup_call_id for a setup call\'s results.');
      const sheet_id = given ?? setupCallSheet(ctx.userId, setup_call_id!);
      if (!sheet_id) return err('Setup call not found');
      // A view is read now: the link saves what it shows at this moment.
      const selection = applyView(sheet_id, ctx.userId, view, { columns, where: where as WhereItem[] | undefined });
      if (!selection) return err('Sheet not found');
      if ('error' in selection) return err(selection.error);
      // A typo'd column must fail now, not when the link is used.
      const plan = planSheetExport(sheet_id, ctx.userId, selection);
      if ('fail' in plan) return err(plan.fail === 'not_found' ? 'Sheet not found' : plan.error);
      const link = createFileLink({
        userId: ctx.userId, tokenId: ctx.tokenId, sheetId: sheet_id, kind: 'download',
        options: { columns: selection.columns, where: selection.where, saved: selection.saved },
      });
      const url = fileLinkUrl(base, 'download', link.token);
      return ok({
        download_url: url,
        curl: `curl -sS -f -o <file.csv> '${url}'`,
        columns: plan.columns,
        expires_at: link.expiresAt,
        note: 'Replace <file.csv> with where to save it. The link works once. If curl fails with 409, the sheet '
          + 'was busy and the link still works, so try again shortly; with 404, the link is used up or expired.',
      });
    },
  );
}
