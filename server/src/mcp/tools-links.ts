// file_link (create_upload_link and create_download_link before v0.8.47): a CSV file of any size into or out
// of a sheet, from any machine that can reach Cubex, without its contents
// passing through the agent's context. The agent gets a one-time link
// (lib/file-links.ts) and moves the file with the curl command that comes with
// it (routes/file-links.ts). Each action needs only what the token can already do:
// write to import (as import_csv), read to export (as read_rows' format csv).
import { verifySheetOwnership } from '../lib/sql-helpers';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { planSheetExport } from '../lib/csv-export';
import { createFileLink, fileLinkUrl } from '../lib/file-links';
import { tooManyMessage } from '../lib/rate-window';
import { MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { FILE_LINK_TTL_MINUTES } from '../lib/api-v1-constants';
import { importWindow } from './tools-import';
import { GUIDE_POINTER } from './guides/guide';
import { actionFieldsProblem } from './action-fields';
import {
  SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, mcpLinkBase,
} from './tool-helpers';
import { VIEW_BRIEF, whereLike } from './where-schema';
import { applyView } from '../services/view-read';
import type { WhereItem } from '../lib/row-filter/where';
import { RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import { prepareFileCall } from '../services/setup-call-file';
import { callInputOf } from '../services/setup-call-input';
import { setupCallSheet } from '../services/setup-call-view';

const MAX_MB = Math.round(MAX_CSV_UPLOAD_BYTES / (1024 * 1024));

// For a token without write: said up front in the tool list, and in full when
// the tool is called anyway, so the agent can tell the user what to change.
const NO_WRITE_NOTE = 'This token has no write permission, so an upload will refuse.';
const NO_WRITE = "This action requires the 'write' scope, which this Cubex access token doesn't have, "
  + 'so no link was made and nothing was imported. To import files, the user can create a token with '
  + 'Write ticked in Cubex (Settings, then Agent access) and connect with it, or import the file '
  + 'themselves: open the sheet in Cubex and click Import.';

const ACTIONS = ['upload', 'download'] as const;
type Field = 'sheet_id' | 'mode' | 'setup_id' | 'max_cost_usd' | 'allow_unpriced' | 'models' | 'webhook_id'
  | 'setup_run_id' | 'columns' | 'where' | 'view' | 'format';
const TAKES = {
  upload: { may: ['sheet_id', 'mode', 'setup_id', 'max_cost_usd', 'allow_unpriced', 'models', 'webhook_id'] },
  download: { may: ['sheet_id', 'setup_run_id', 'columns', 'where', 'view', 'format'] },
} as const satisfies Record<typeof ACTIONS[number], { may: readonly Field[] }>;

type UploadArgs = {
  sheet_id?: string; mode?: 'append' | 'replace'; setup_id?: string; max_cost_usd?: number; allow_unpriced?: boolean;
  models?: Record<string, string>; webhook_id?: string;
};
type DownloadArgs = {
  sheet_id?: string; setup_run_id?: string; columns?: string[]; where?: unknown; view?: string;
  format?: 'csv' | 'jsonl';
};

export function registerLinkTools(server: McpServer, ctx: McpAuthCtx) {
  const base = mcpLinkBase(ctx);
  const canWrite = ctx.scopes.has('write');

  // upload: a CSV file into a sheet, or a setup call's items.
  async function upload({ sheet_id, mode, setup_id, ...call }: UploadArgs) {
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
  }

  // download: a sheet, the columns and rows picked, or a setup call's items.
  async function download({ sheet_id: given, setup_run_id, columns, where, view, format }: DownloadArgs) {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    if (!given === !setup_run_id) return err('Pass sheet_id, or setup_run_id for a setup call\'s results.');
    const sheet_id = given ?? setupCallSheet(ctx.userId, setup_run_id!);
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
      options: {
        columns: selection.columns, where: selection.where, saved: selection.saved, format: format ?? 'csv',
      },
    });
    const url = fileLinkUrl(base, 'download', link.token);
    const file = format === 'jsonl' ? '<file.jsonl>' : '<file.csv>';
    return ok({
      download_url: url,
      curl: `curl -sS -f -o ${file} '${url}'`,
      columns: plan.columns,
      expires_at: link.expiresAt,
      note: `Replace ${file} with where to save it. The link works once. If curl fails with 409, the sheet `
        + 'was busy and the link still works, so try again shortly; with 404, the link is used up or expired.',
    });
  }

  registerTool(server,
    'file_link',
    {
      description:
        'A one-time link to move a CSV file of any size into or out of a sheet without its contents passing '
        + 'through your context, with the curl command to use it, from any machine that can reach Cubex. The link '
        + `works once and expires in ${FILE_LINK_TTL_MINUTES} minutes. upload: import a file (up to ${MAX_MB} MB) `
        + 'into sheet_id, with import_csv\'s header rules; mode "replace" deletes all existing rows when the file '
        + 'arrives (to the trash, restorable). Needs the write scope. With setup_id instead of sheet_id, the rows are '
        + 'a setup call\'s items (apply_setup with items): it starts once the file is in, COSTS MONEY, and needs '
        + 'max_cost_usd and the run scope. download: save a sheet, or the columns and rows you pick (as in '
        + 'read_rows), as CSV, or jsonl (one {"id", "data"} object a row, as read_rows answers it); or a setup '
        + 'call\'s items by setup_run_id. Anyone who has a download link can download the data until it expires, so '
        + 'give it only to the user.'
        + (canWrite ? '' : ` ${NO_WRITE_NOTE}`) + ` ${GUIDE_POINTER}`,
      inputSchema: {
        action: z.enum(ACTIONS).describe('upload or download'),
        sheet_id: z.string().optional().describe(`${SHEET_ID}. Or setup_id (upload) or setup_run_id (download).`),
        mode: z.enum(['append', 'replace']).optional().describe('upload: default append'),
        setup_id: z.string().optional().describe('upload: or call this setup on the file\'s rows'),
        max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional()
          .describe('upload with setup_id, required: the most it may cost, in dollars'),
        allow_unpriced: lenientBoolean().optional().describe('upload with setup_id: start a step with no known price'),
        models: z.record(z.string(), z.string()).optional().describe('upload with setup_id: AI step column -> model'),
        webhook_id: z.string().optional().describe('upload with setup_id: a run webhook to notify'),
        setup_run_id: z.string().optional().describe('download: or a setup call\'s items (its setup_run_id)'),
        columns: z.array(z.string()).min(1).optional()
          .describe('download: only these columns, in this order. Omit for every column.'),
        where: whereLike('download: only the rows it passes.').optional(),
        view: z.string().min(1).optional().describe(`download: ${VIEW_BRIEF}`),
        format: z.enum(['csv', 'jsonl']).optional().describe('download: csv (default) or jsonl, one JSON object a row'),
      },
    },
    async ({ action, ...a }: { action: typeof ACTIONS[number] } & Partial<Record<Field, any>>) => {
      const problem = actionFieldsProblem<typeof ACTIONS[number], Field>(action, a, TAKES);
      if (problem) return err(problem);
      return action === 'upload' ? upload(a) : download(a);
    },
  );
}
