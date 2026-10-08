// An enrichment column's own setup, from its newest run: what "Edit
// enrichment" opens Set up with (the tool's card and every choice), and what
// the column menu's reruns start from (services/enrich-rerun.ts). A pure read.
import { db } from '../lib/db';
import { isEnrichmentConfig, type EnrichRunConfig } from '../lib/enrich-run-config';
import { recallChoices, type RecalledChoices } from '../lib/enrich-run-recall';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { toolCard, type ListedTool } from './enrich-catalog';
import type { RunFail } from './run-shared';
import { entryFor } from './autorun-entry';

export interface ColumnRun { id: string; status: string; active: boolean; config: EnrichRunConfig }

// The newest run that wrote `column` as its status column, when it is an
// enrichment (null: no run, or a plain HTTP column).
export function newestColumnRun(sheetId: string, userId: string, column: string): ColumnRun | null {
  const row = db.prepare(`SELECT id, status, placeholder_work, config FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sheetId, userId, column) as
    { id: string; status: string; placeholder_work: string | null; config: string | null } | undefined;
  if (!row) return null;
  let config: unknown = null;
  try { config = JSON.parse(row.config ?? 'null'); } catch { return null; }
  if (!isEnrichmentConfig(config)) return null;
  const active = ['pending', 'running', 'paused'].includes(row.status) || row.placeholder_work !== null;
  return { id: row.id, status: row.status, active, config };
}

export interface ColumnSetup {
  choices: RecalledChoices;
  // The tool as a card, or why treg's catalog can't give it now (retired,
  // unreachable): the drawer then offers to pick another tool.
  card: ListedTool | null;
  toolError: string | null;
  activeRunId: string | null;
  // The column's auto-run, for Set up's checkbox (null: never turned on).
  autorun: { enabled: boolean; dailyCapUsd: number | null } | null;
}

export function loadColumnRun(sheetId: string, userId: string, column: string): ColumnRun | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const run = newestColumnRun(sheetId, userId, column);
  return run ?? { fail: 'bad_request', message: `"${column}" isn't an enrichment column.` };
}

export async function columnSetup(
  userId: string, sheetId: string, column: string,
): Promise<{ ok: ColumnSetup } | RunFail> {
  const run = loadColumnRun(sheetId, userId, column);
  if ('fail' in run) return run;
  const choices = recallChoices(run.config, column);
  const card = await toolCard(choices.toolId, choices.preset);
  const entry = entryFor(sheetId, userId, column);
  return {
    ok: {
      choices, card: 'ok' in card ? card.ok : null, toolError: 'ok' in card ? null : card.message,
      activeRunId: run.active ? run.id : null,
      autorun: entry ? {
        enabled: entry.enabled === 1, dailyCapUsd: entry.daily_cap_micro === null ? null : entry.daily_cap_micro / 1e6,
      } : null,
    },
  };
}
