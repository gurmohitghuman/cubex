// create_upload_link / create_download_link: a CSV file of any size into or out
// of a sheet, from any machine that can reach Cubex, without its contents
// passing through the agent's context. The agent gets a one-time link
// (lib/file-links.ts) and moves the file with the curl command that comes with
// it (routes/file-links.ts). Each needs only what the token can already do:
// write to import (as import_csv), read to export (as export_csv).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../lib/db';
import { planSheetExport } from '../lib/csv-export';
import { createFileLink, fileLinkUrl } from '../lib/file-links';
import { tooManyMessage } from '../lib/rate-window';
import { MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { FILE_LINK_TTL_MINUTES } from '../lib/api-v1-constants';
import { importWindow } from './tools-import';
import { McpAuthCtx, ok, err, missingScope, registerTool, rowConditionSchema as condition } from './tool-helpers';

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
        + 'Same header rules as import_csv; mode "replace" DELETES all existing rows when the file arrives '
        + `(permanent). The link works once and expires in ${FILE_LINK_TTL_MINUTES} minutes. Needs the write scope.`
        + (canWrite ? '' : ` ${NO_WRITE_NOTE}`),
      inputSchema: {
        sheet_id: z.string(),
        mode: z.enum(['append', 'replace']).optional().describe('Default append'),
      },
    },
    async ({ sheet_id, mode }) => {
      if (!canWrite) return err(NO_WRITE);
      if (!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheet_id, ctx.userId)) {
        return err('Sheet not found');
      }
      // Each link is one import, so it takes a slot from the same budget.
      const slot = importWindow(ctx.tokenId);
      if (!slot.allowed) return err(tooManyMessage('CSV imports', slot));
      const chosen = mode ?? 'append';
      const link = createFileLink({
        userId: ctx.userId, tokenId: ctx.tokenId, sheetId: sheet_id, kind: 'upload', options: { mode: chosen },
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
        + 'download the data, so give it only to the user. Values are escaped against spreadsheet formula injection.',
      inputSchema: {
        sheet_id: z.string(),
        columns: z.array(z.string()).min(1).optional()
          .describe('Only these columns, in this order. Omit for every column.'),
        where: z.array(condition).min(1).optional()
          .describe('Only rows matching ALL conditions, the same filter shape as read_rows.'),
      },
    },
    async ({ sheet_id, columns, where }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      // A typo'd column must fail now, not when the link is used.
      const plan = planSheetExport(sheet_id, ctx.userId, { columns, where });
      if ('fail' in plan) return err(plan.fail === 'not_found' ? 'Sheet not found' : plan.error);
      const link = createFileLink({
        userId: ctx.userId, tokenId: ctx.tokenId, sheetId: sheet_id, kind: 'download', options: { columns, where },
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
