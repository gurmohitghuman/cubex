// A setup called on a file's rows (services/setup-call.ts), for MCP's create_upload_link with setup_id
// (routes/file-links.ts) and REST's POST /v1/setups/:id/calls/file (routes/api-v1-setup-calls.ts): the file is
// imported into a hidden working table made with one column per setup input (a column the setup doesn't read is
// kept and ignored, an input the file lacks reads as empty), and the call starts once the rows are in. Nobody sees
// an estimate first, so a file call needs max_cost_usd: a file whose estimate could pass it starts nothing, and its
// working table goes. Results: get_setup_call a page at a time, or create_download_link with setup_call_id.
import { getSetup } from './setup-library';
import { webhookIdProblem } from './run-hooks-attach';
import { newWorkingTable, removeWorkingTable, startCall, type CallInput, type StartOutcome } from './setup-call';
import type { ApplyFail } from './setup-apply';
import { db } from '../lib/db';

// What an upload link keeps for the call it starts (file_links.options.call).
export interface CallLinkOptions {
  setupId: string; tableId: string; models?: Record<string, string>; webhookId: string | null;
  maxCostUsd: number; allowUnpriced: boolean; secrets: boolean;
}

export const NEEDS_CEILING = 'A setup call on a file needs max_cost_usd: nobody sees its estimate before it starts. '
  + 'Price it first with call_setup on a few items (estimate_only) to pick one.';

// The working table a file goes into, and what the call will start with.
export function prepareFileCall(
  userId: string, setupId: string, input: CallInput, caller: { hasSecretsScope: boolean },
): { sheetId: string; call: CallLinkOptions } | ApplyFail {
  const setup = getSetup(userId, setupId);
  if (!setup) return { fail: 'not_found', message: 'Setup not found' };
  if (input.maxCostUsd === null || input.maxCostUsd === undefined) {
    return { fail: 'bad_request', message: NEEDS_CEILING };
  }
  const hook = webhookIdProblem(userId, input.webhookId);
  if (hook) return { fail: 'bad_request', message: hook };
  const work = newWorkingTable(userId, setup.spec);
  if ('fail' in work) return work;
  return {
    sheetId: work.sheetId,
    call: {
      setupId, tableId: work.tableId, models: input.models, webhookId: input.webhookId ?? null,
      maxCostUsd: input.maxCostUsd, allowUnpriced: !!input.allowUnpriced, secrets: caller.hasSecretsScope,
    },
  };
}

// Once the file's rows are in: the call starts (or is refused, and its working table goes). A file with no rows
// starts nothing.
export async function startFileCall(userId: string, sheetId: string, call: CallLinkOptions): Promise<StartOutcome> {
  const rows = db.prepare('SELECT 1 FROM rows WHERE sheet_id = ? AND user_id = ? LIMIT 1').get(sheetId, userId);
  if (!rows) {
    removeWorkingTable(userId, call.tableId);
    return { fail: 'bad_request', message: 'The file has no rows, so the setup has nothing to run on.' };
  }
  return startCall(userId, call.setupId, { tableId: call.tableId, sheetId }, {
    models: call.models, estimateOnly: false, webhookId: call.webhookId, maxCostUsd: call.maxCostUsd,
    allowUnpriced: call.allowUnpriced,
  }, { hasSecretsScope: call.secrets });
}

// The import failed and the link is used up: its working table goes now, not at the sweep.
export const dropFileCall = (userId: string, call: CallLinkOptions): void => removeWorkingTable(userId, call.tableId);
