// Turning auto-run on, off or pausing it, for an enrichment or HTTP API
// column, or a clean data column (clean-column.ts) (the column menu's dialog, the drawer's checkbox, the sheet header's
// chip; MCP set_auto_run and /api/v1 call it too). Auto-run repeats the
// column's newest run on new rows and rows whose inputs get filled, once per
// row (lib/autorun-rules.ts). Turning it on starts from the sheet as it is:
// rows already there are left alone, so turning it on never spends on them.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import {
  AUTORUN_DEFAULT_DAILY_CAP_USD, AUTORUN_HTTP_DEFAULT_DAILY_ROWS, AUTORUN_HTTP_MAX_DAILY_ROWS,
  ENRICH_DAILY_LIMIT_MAX_USD,
} from '../lib/constants';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { isEnrichmentConfig, type EnrichCondition } from '../lib/enrich-run-config';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import { missingRequestRead, requestColumns, watchedColumns } from '../lib/autorun-rules';
import { autorunDropPending } from '../lib/autorun-mark';
import { httpRunSecretRefsRequiringScope } from '../lib/http-secrets-scan';
import { goneColumnMessage } from '../lib/template-token-match';
import { columnOutputs, entryFor, inputColumnsOf, newestRunOf, usableKeyNames, whereOf } from './autorun-entry';
import { getDailyLimitMicro } from './treg-key';
import { autorunListProblem } from './autorun-list';
import type { RunFail } from './run-shared';
import { checkRunRule } from './run-rule';
import { cleanColumnFor } from '../lib/clean-columns';
import { formulaColumnFor } from '../lib/formula-columns';
import { setCleanColumnAutorun } from './clean-column';
import { setFormulaColumnAutorun } from './formula-column';

export interface AutorunSettingsInput {
  column: string;
  enabled: boolean;
  where: EnrichCondition[] | null;      // null: keep (or the run's own "Only run if" on a first turn-on)
  // The "Only run if" rule (lib/run-condition.ts): undefined keeps it (or, on
  // a first turn-on, takes the column's newest run's); '' or null clears it.
  runIf?: string | null;
  dailyCapUsd: number | null;           // enrichment columns
  dailyRowCap: number | null;           // HTTP API columns
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// unpriced: the team's own provider key bills the tool directly, so no dollar
// cap is asked for. One given is kept: treg may price the tool later (auto-run
// then pauses as 'priced' until the column has a cap).
function capsFor(
  userId: string, kind: 'enrichment' | 'http', input: AutorunSettingsInput,
  prior: { daily_cap_micro: number | null; daily_row_cap: number | null } | undefined, unpriced: boolean,
): { capMicro: number | null; rowCap: number | null } | RunFail {
  if (kind === 'http') {
    const rows = input.dailyRowCap ?? prior?.daily_row_cap ?? AUTORUN_HTTP_DEFAULT_DAILY_ROWS;
    if (!Number.isSafeInteger(rows) || rows < 1 || rows > AUTORUN_HTTP_MAX_DAILY_ROWS) {
      return bad(`Rows a day must be a whole number from 1 to ${AUTORUN_HTTP_MAX_DAILY_ROWS.toLocaleString('en-US')}.`);
    }
    return { capMicro: null, rowCap: rows };
  }
  if (unpriced && input.dailyCapUsd === null) return { capMicro: null, rowCap: null };
  const usd = input.dailyCapUsd ?? (prior?.daily_cap_micro != null ? prior.daily_cap_micro / 1e6 : null)
    ?? AUTORUN_DEFAULT_DAILY_CAP_USD;
  if (!Number.isFinite(usd) || usd <= 0 || usd > ENRICH_DAILY_LIMIT_MAX_USD) {
    return bad('The daily cap must be more than $0.');
  }
  // Never above the daily limit for all enrichments: that one caps it anyway.
  const limit = getDailyLimitMicro(userId);
  const micro = Math.round(usd * 1e6);
  return { capMicro: limit === null ? micro : Math.min(micro, limit), rowCap: null };
}

export async function saveAutorunSettings(
  userId: string, sheetId: string, input: AutorunSettingsInput, opts: { hasSecretsScope: boolean },
): Promise<{ ok: { column: string } } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const columns = getSheetColumns(sheetId, userId, false);
  if (!columns.includes(input.column)) return bad(`There's no column named "${input.column}".`);
  // A clean or formula column's auto-run follows its inputs; it has no rule or caps.
  const clean = cleanColumnFor(sheetId, userId, input.column);
  const formula = clean ? undefined : formulaColumnFor(sheetId, userId, input.column);
  if (clean || formula) {
    const extra = (input.where?.length ?? 0) > 0 || !!input.runIf
      || (input.dailyCapUsd ?? null) !== null || (input.dailyRowCap ?? null) !== null;
    const what = clean ? 'a clean' : 'a formula';
    if (extra && input.enabled) return bad(`The auto-run of ${what} column has no rule or cap: it's free.`);
    return clean
      ? setCleanColumnAutorun(userId, sheetId, clean, input.enabled)
      : setFormulaColumnAutorun(userId, sheetId, formula!, input.enabled);
  }
  const prior = entryFor(sheetId, userId, input.column);
  if (!input.enabled) {
    if (prior) {
      db.prepare(`UPDATE autorun_columns SET enabled = 0, paused_reason = NULL, paused_message = NULL,
        paused_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(prior.id);
    }
    return { ok: { column: input.column } };
  }

  const newest = newestRunOf(sheetId, userId, input.column);
  let config: HTTPAPIConfig | null = null;
  try { config = JSON.parse(newest?.config ?? 'null'); } catch { /* checked below */ }
  if (!newest || !config?.requestConfig) {
    return bad('Run this column once first: auto-run repeats its newest run.');
  }
  const kind = isEnrichmentConfig(config) ? 'enrichment' as const : 'http' as const;
  // A column that adds rows elsewhere: its fields picked, its sheet there, no loop back here.
  const listProblem = autorunListProblem(sheetId, userId, config);
  if (listProblem) return bad(listProblem);
  const where = input.where ?? (prior ? whereOf(prior) : kind === 'enrichment' && isEnrichmentConfig(config)
    ? config.enrichment.rows.where : []);
  const missing = where.find(c => !columns.includes(c.column));
  if (missing) return bad(`"Only run if" reads ${missing.column}, which isn't in this sheet.`);
  const ruleText = input.runIf !== undefined ? input.runIf : prior ? prior.run_if : config.runIf ?? null;
  const rule = checkRunRule(sheetId, userId, ruleText);
  if ('error' in rule) return bad(rule.error);
  const runIf = rule.ok?.rule ?? null;
  // As the tick asks (autorun-loop.ts setupOf): a column it watched before
  // still counts, so turning it off and on can't forget a deleted input.
  const gone = missingRequestRead(config, columns, prior ? inputColumnsOf(prior) : [],
    usableKeyNames(userId, newest.allow_secrets));
  if (gone) return bad(goneColumnMessage(gone));
  const reads = requestColumns(config, columns);
  const own = new Set([input.column, ...columnOutputs(sheetId, userId, input.column)]);
  const selfRead = watchedColumns(reads, where, runIf).filter(c => own.has(c));
  if (selfRead.length) {
    return bad(`Auto-run can't read this column's own results (${selfRead.join(', ')}). Pick other columns.`);
  }
  // Auto-run repeats the newest run with its own key policy; a caller that
  // can't use saved keys can't set it up to use them (as run-rerun-by-id).
  if (kind === 'http' && !opts.hasSecretsScope) {
    const refs = httpRunSecretRefsRequiringScope(userId, newest, false);
    if (refs.length) {
      return { fail: 'forbidden', message: `This column uses saved API key(s): ${refs.join(', ')}. `
        + "Turning on its auto-run requires the 'secrets' scope." };
    }
  }
  const unpriced = isEnrichmentConfig(config) && config.enrichment.maxCostPerRowUsd === null;
  const caps = capsFor(userId, kind, input, prior, unpriced);
  if ('fail' in caps) return caps;

  const watched = JSON.stringify(watchedColumns(reads, where, runIf));
  // A first turn-on (or after it was off) starts from the rows there now.
  const fresh = !prior || !prior.enabled;
  if (prior && fresh) await autorunDropPending(sheetId, userId, prior.id);
  db.transaction(() => {
    const top = db.prepare('SELECT IFNULL(MAX(row_index), -1) FROM rows WHERE sheet_id = ? AND user_id = ?')
      .pluck().get(sheetId, userId) as number;
    const gen = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
      .pluck().get(sheetId, userId) as number;
    if (prior && fresh) db.prepare('DELETE FROM autorun_pending WHERE autorun_id = ?').run(prior.id);
    db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, enabled, input_columns,
        where_json, run_if, daily_cap_micro, daily_row_cap, watermark_row_index, rescan, row_generation_seen)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(sheet_id, status_column) DO UPDATE SET enabled = 1, kind = excluded.kind,
        input_columns = excluded.input_columns, where_json = excluded.where_json, run_if = excluded.run_if,
        daily_cap_micro = excluded.daily_cap_micro, daily_row_cap = excluded.daily_row_cap,
        watermark_row_index = CASE WHEN ? THEN excluded.watermark_row_index ELSE watermark_row_index END,
        row_generation_seen = CASE WHEN ? THEN excluded.row_generation_seen ELSE row_generation_seen END,
        rescan = 1, paused_reason = NULL, paused_message = NULL, paused_at = NULL, updated_at = datetime('now')`)
      .run(uuidv4(), userId, sheetId, input.column, kind, watched, JSON.stringify(where), runIf, caps.capMicro,
        caps.rowCap, top, gen, fresh ? 1 : 0, fresh ? 1 : 0);
  }).immediate();
  return { ok: { column: input.column } };
}

// The sheet header's "Pause all" / "Resume all", or one column's Pause (the
// dialog). A pause keeps its place: rows added meanwhile run on resume.
export function setSheetAutorunPaused(userId: string, sheetId: string, paused: boolean, column?: string): boolean {
  if (!verifySheetOwnership(sheetId, userId)) return false;
  const one = column === undefined ? '' : ' AND status_column = ?';
  const params = column === undefined ? [sheetId, userId] : [sheetId, userId, column];
  if (paused) {
    db.prepare(`UPDATE autorun_columns SET paused_reason = 'user', paused_message = ?, paused_at = datetime('now'),
        updated_at = datetime('now') WHERE sheet_id = ? AND user_id = ? AND enabled = 1${one}`)
      .run('Resume it to go on; rows added meanwhile run then.', ...params);
  } else {
    db.prepare(`UPDATE autorun_columns SET paused_reason = NULL, paused_message = NULL, paused_at = NULL,
        rescan = 1, updated_at = datetime('now') WHERE sheet_id = ? AND user_id = ? AND enabled = 1${one}`)
      .run(...params);
  }
  return true;
}
