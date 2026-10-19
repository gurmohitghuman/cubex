// Setup versions: a sheet's column setup kept by name, compared with the sheet
// now and restored (services/setup-version-*.ts; REST /v1/sheets/:id/setup-versions
// and the app's sheet menu do the same). list_setup_versions,
// manage_setup_version (save, rename, delete), restore_setup_version.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_SETUP_VERSIONS_PER_SHEET } from '../lib/constants-setups';
import {
  deleteSetupVersion, listSetupVersions, saveSetupVersion, updateSetupVersion,
} from '../services/setup-version-store';
import { restoreSetupVersion } from '../services/setup-version-restore';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

const WHAT =
  'A setup version is a named copy of how a sheet\'s columns are set up, never their values: every column in '
  + 'order with its description, what fills it (an AI column\'s prompt, model and settings; an HTTP API, '
  + 'enrichment or waterfall column\'s request or choices; a clean, formula or lookup column\'s settings), its '
  + '"Only run if" rule and auto-run. ';

export function registerSetupVersionTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'list_setup_versions', {
    description: WHAT + 'Without version_id: the sheet\'s versions, newest first (name, when, who saved it, how many '
      + 'columns and filled columns; auto true for a copy a restore kept of the setup it replaced). With '
      + 'version_id: that version against the sheet now, the same answer as restore_setup_version with dry_run: '
      + 'each column the version names that is gone (restoring adds it back, empty), set up differently (field by '
      + 'field, version vs now), filled another way now (restoring leaves it) or not in the version (it stays). '
      + 'Changes nothing. Request URLs are masked, headers show by name and request bodies only as changed.',
    inputSchema: z.object({
      sheet_id: z.string(),
      version_id: z.string().optional().describe('One version against the sheet now; leave out for the list'),
    }).strict(),
  }, async ({ sheet_id, version_id }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    if (version_id === undefined) {
      const versions = listSetupVersions(sheet_id, ctx.userId);
      return versions ? ok({ versions }) : err('Sheet not found');
    }
    const out = await restoreSetupVersion(sheet_id, ctx.userId, version_id,
      { dryRun: true, hasSecretsScope: ctx.scopes.has('secrets'), reveal: false });
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'manage_setup_version', {
    description: WHAT + 'action save keeps the sheet\'s setup as it is now under name (unique in the sheet, '
      + `ignoring case; a sheet keeps at most ${MAX_SETUP_VERSIONS_PER_SHEET}): do it before changing prompts, `
      + 'requests or formulas, so they can be put back. rename changes a version\'s name or description '
      + '(version_id). delete deletes a version (version_id): it can\'t be undone, and the sheet doesn\'t '
      + 'change. Saving only reads the sheet. The sheet\'s History lists each save.',
    inputSchema: z.object({
      sheet_id: z.string(),
      action: z.enum(['save', 'rename', 'delete']),
      version_id: z.string().optional().describe('rename and delete: the version'),
      name: z.string().optional().describe('save: required; rename: the new name'),
      description: z.string().optional().describe('What the version is, in a sentence'),
    }).strict(),
  }, async ({ sheet_id, action, version_id, name, description }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    if (action === 'save') {
      if (version_id !== undefined) return err('save makes a new version: leave version_id out.');
      const out = saveSetupVersion(sheet_id, ctx.userId, { name, description });
      return 'ok' in out ? ok({ version: out.ok }) : err(out.message);
    }
    if (!version_id) return err(`${action} needs version_id (list_setup_versions lists them).`);
    const out = action === 'rename'
      ? updateSetupVersion(sheet_id, ctx.userId, version_id, { name, description })
      : deleteSetupVersion(sheet_id, ctx.userId, version_id);
    return 'ok' in out ? ok(action === 'rename' ? { version: out.ok } : { ok: true }) : err(out.message);
  });

  registerTool(server, 'restore_setup_version', {
    description: 'Put a sheet\'s column setup back as a setup version has it. ' + WHAT + 'DEFAULT dry_run true: '
      + 'only says what restoring would do, column by column, and `blocked`: why it can\'t be restored now. With '
      + 'dry_run false it first keeps the setup it replaces as a version of its own ("Before restoring: …", auto), '
      + 'then: columns the version names that are '
      + 'gone come back EMPTY, with their setup; columns set up differently get the version\'s setup; every '
      + 'column\'s description and the column order follow the version; columns the version doesn\'t have stay '
      + 'as they are; a column filled another way now (an AI column where the version had a formula, a plain '
      + 'column where it had an AI column) is left, and its note says why; so is an AI column whose output '
      + 'column is filled another way now, and an HTTP API column comes back without a field whose column is. '
      + 'NOTHING RUNS AND NOTHING IS BILLED, '
      + 'and no cell changes: cells keep what they hold. An AI, HTTP API, enrichment or waterfall column then '
      + 'runs the restored way the next time it runs (control_run rerun with mode all, which bills every row; '
      + 'run_ai_column with the same column; '
      + 'auto-run on new rows); its newest run is a record that ran nothing (get_sheet shows run_status '
      + '"restored", list_runs leaves it out). A clean, formula or lookup column keeps its cells until it is '
      + 'worked out again (clean_column, formula_column or lookup_column on its own column, free). Auto-run '
      + 'goes on or off as the version has it, starting from the rows there now (rows already there never run '
      + 'because of a restore; one already on goes on from where it was); one paused by hand stays paused. '
      + 'Refused while a run or a setup is going on the sheet, or a clean, formula or lookup column is still '
      + 'filling. Needs the write and run scopes (secrets too when a request it puts back reads saved keys); a '
      + 'dry run needs read. The sheet\'s History lists each restore.',
    inputSchema: z.object({
      sheet_id: z.string(),
      version_id: z.string(),
      dry_run: lenientBoolean().optional().describe('Default true: only say what restoring would do'),
    }).strict(),
  }, async ({ sheet_id, version_id, dry_run }) => {
    const denied = dry_run === false ? missingScope(ctx, 'write') ?? missingScope(ctx, 'run')
      : missingScope(ctx, 'read');
    if (denied) return denied;
    const dryRun = dry_run !== false;
    const out = await restoreSetupVersion(sheet_id, ctx.userId, version_id,
      { dryRun, hasSecretsScope: ctx.scopes.has('secrets'), reveal: false });
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
