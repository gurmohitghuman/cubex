// Setup versions: a sheet's column setup kept by name, compared with the sheet
// now and restored (services/setup-version-*.ts; REST /v1/sheets/:id/setup-versions
// and the app's sheet menu do the same). list_setup_versions, and
// manage_setup_version (save, rename, delete, and restore: restore_setup_version before v0.8.47).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { MAX_SETUP_VERSIONS_PER_SHEET } from '../lib/constants-setups';
import {
  deleteSetupVersion, listSetupVersions, saveSetupVersion, updateSetupVersion,
} from '../services/setup-version-store';
import { restoreSetupVersion } from '../services/setup-version-restore';
import { SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { changedOf } from './changed';
import { GUIDE_POINTER } from './guides/guide';
import { actionFieldsProblem } from './action-fields';

// restore's own field (restore_setup_version's before v0.8.47), for REST's body (openapi/routes-setups.ts).
export const RESTORE_INPUT = {
  dry_run: lenientBoolean().optional().describe('Default true: only say what restoring would do'),
};
const ACTIONS = ['save', 'rename', 'delete', 'restore'] as const;
type Field = 'version_id' | 'name' | 'description' | 'dry_run';
const TAKES = {
  // A save without a name is refused by the service, in words that say what a name is for.
  save: { may: ['name', 'description'] },
  rename: { needs: ['version_id'], may: ['name', 'description'] },
  delete: { needs: ['version_id'] },
  restore: { needs: ['version_id'], may: ['dry_run'] },
} as const satisfies Record<typeof ACTIONS[number], { needs?: readonly Field[]; may?: readonly Field[] }>;

const WHAT =
  'A setup version is a named copy of how a sheet\'s columns are set up, never their values: every column in '
  + 'order with its description, what fills it (an AI column\'s prompt, model and settings; an HTTP API, '
  + 'enrichment or waterfall column\'s request or choices; a clean, formula or lookup column\'s settings), its '
  + '"Only run if" rule and auto-run. ';

export function registerSetupVersionTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'list_setup_versions', {
    // Its details, and manage_setup_version's restore, are in their guides (mcp/guides/setups.ts).
    description: 'A setup version is a named copy of how a sheet\'s columns are set up, never their values. Without '
      + 'version_id: the sheet\'s versions, newest first. With version_id: that version against the sheet now, '
      + `column by column (manage_setup_version's restore, as a dry run). Changes nothing. ${GUIDE_POINTER}`,
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
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
      + 'change. Saving only reads the sheet. The sheet\'s History lists each save. restore puts the sheet\'s '
      + 'column setup back as the version has it: DEFAULT dry_run true only says what it would do, column by '
      + 'column, and `blocked`: why it can\'t now; with dry_run false gone columns come back EMPTY, with their '
      + 'setup. NOTHING RUNS AND NOTHING IS BILLED, and no cell changes. A restore needs the write and run scopes '
      + `(secrets too when a request it puts back reads saved keys); its dry run needs read. ${GUIDE_POINTER}`,
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
      action: z.enum(ACTIONS).describe('What to do'),
      version_id: z.string().optional().describe('rename, delete and restore: the version (list_setup_versions)'),
      name: z.string().optional().describe('save: required; rename: the new name'),
      description: z.string().optional().describe('save and rename: what the version is, in a sentence'),
      dry_run: RESTORE_INPUT.dry_run.describe('restore: default true, only say what restoring would do'),
    }).strict(),
  }, async ({ sheet_id, action, ...a }) => {
    const denied = action !== 'restore' ? missingScope(ctx, 'write')
      : a.dry_run === false ? missingScope(ctx, 'write') ?? missingScope(ctx, 'run')
      : missingScope(ctx, 'read');
    if (denied) return denied;
    const problem = actionFieldsProblem<typeof ACTIONS[number], Field>(action, a, TAKES);
    if (problem) return err(problem.replace('needs version_id.', 'needs version_id (list_setup_versions lists '
      + 'them).'));
    const { version_id, name, description } = a;
    if (action === 'save') {
      const out = saveSetupVersion(sheet_id, ctx.userId, { name, description });
      return 'ok' in out ? ok({ version: out.ok, changed: [] }) : err(out.message);
    }
    if (action === 'rename') {
      const out = updateSetupVersion(sheet_id, ctx.userId, version_id!, { name, description });
      return 'ok' in out ? ok({ version: out.ok, changed: [] }) : err(out.message);
    }
    if (action === 'delete') {
      const out = deleteSetupVersion(sheet_id, ctx.userId, version_id!);
      return 'ok' in out ? ok({ ok: true, changed: [] }) : err(out.message);
    }
    const out = await restoreSetupVersion(sheet_id, ctx.userId, version_id!,
      { dryRun: a.dry_run !== false, hasSecretsScope: ctx.scopes.has('secrets'), reveal: false });
    if (!('ok' in out)) return err(out.message);
    // The columns it adds back or sets up again; a clean, formula or lookup column fills again on its own.
    const set = out.ok.columns.filter(c => c.action === 'add_back' || c.action === 'restore');
    const changed = out.ok.dry_run || out.ok.nothing || (!set.length && !out.ok.order_changed) ? []
      : changedOf(ctx.userId, [{ sheetId: sheet_id, columns: set.map(c => c.column),
        moreComing: set.some(c => c.kind === 'clean' || c.kind === 'formula' || c.kind === 'lookup') }]);
    return ok({ ...out.ok, changed });
  });
}
