// An auto-run entry (autorun_columns, migrations 010 and 013): reading it,
// today's usage, and the pauses every part shares. Plain DB access, so the run
// workers use the pause helpers too.
import { db } from '../lib/db';
import { redactSecrets } from '../lib/redact';
import { utcDay } from '../lib/clock';
import type { EnrichCondition } from '../lib/enrich-run-config';
import type { AutorunKind } from '../lib/autorun-rules';
import { parseRule, type RuleNode } from '../lib/run-condition-parse';

export interface AutorunEntry {
  id: string; user_id: string; sheet_id: string; status_column: string; kind: AutorunKind;
  enabled: number; input_columns: string; where_json: string | null; run_if: string | null;
  daily_cap_micro: number | null; daily_row_cap: number | null;
  watermark_row_index: number; rescan: number; row_generation_seen: number; data_version_seen: number;
  paused_reason: string | null; paused_message: string | null; paused_at: string | null;
  access_token_id: string | null;   // whose spend cap its batches count against (migration 042)
}

// Why an auto-run stopped. Some clear on their own: the capacity ones once
// today's caps allow a row again (midnight UTC, or a raise); the treg ones are
// retried a few minutes on; 'ai_credits' (OpenRouter's credits ran out) once
// OpenRouter reports some; a missing column once it is back; a key problem when
// a key is saved ('ai_key', OpenRouter refusing a waterfall's AI step, when an
// OpenRouter key is); 'token_cap' once the access token that turned it on
// has room under its spend cap again (a raise); 'loop' (a list auto-run whose rows would come back and
// set it off again) once nothing adds rows back. 'user', 'retired', 'setup',
// 'priced' (treg prices a tool the team's own key billed: it needs a daily
// cap) and 'failed' wait for the person (saving auto-run again, or a new run
// of the column).
export const CAPACITY_PAUSES = new Set(['column_cap', 'row_cap', 'daily_limit']);
export const RETRY_PAUSES = new Set([
  'unreachable', 'balance', 'treg_cap', 'provider_busy', 'unconfirmed', 'team_rule', 'queue',
  'over_cap',   // a waterfall's rows now cost more than what's left of today's cap (its prices rose)
  'provider_errors',   // an HTTP API column's rows kept failing on the API's side (lib/run-breaker.ts)
]);
export const KEY_PAUSES = new Set(['auth', 'no_key']);

const listOf = (raw: string | null): unknown[] => {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};

export const inputColumnsOf = (e: Pick<AutorunEntry, 'input_columns'>): string[] =>
  listOf(e.input_columns).filter((c): c is string => typeof c === 'string');

export const whereOf = (e: Pick<AutorunEntry, 'where_json'>): EnrichCondition[] =>
  listOf(e.where_json).filter((c): c is EnrichCondition => !!c && typeof c === 'object'
    && typeof (c as EnrichCondition).column === 'string' && typeof (c as EnrichCondition).op === 'string');

// Its "Only run if" rule, read (saved checked, renames rewrite it). One that no
// longer reads lets no row through rather than every row.
export function ruleReads(e: Pick<AutorunEntry, 'run_if'>): boolean {
  if (!e.run_if) return true;
  try { parseRule(e.run_if); return true; } catch { return false; }
}

export function ruleOf(e: Pick<AutorunEntry, 'run_if'>): RuleNode | null {
  if (!e.run_if) return null;
  try { return parseRule(e.run_if); } catch { return { kind: 'or', items: [] }; }
}

export function loadEntry(id: string): AutorunEntry | undefined {
  return db.prepare('SELECT * FROM autorun_columns WHERE id = ?').get(id) as AutorunEntry | undefined;
}

export function entryFor(sheetId: string, userId: string, column: string): AutorunEntry | undefined {
  return db.prepare('SELECT * FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND status_column = ?')
    .get(sheetId, userId, column) as AutorunEntry | undefined;
}

export function sheetEntries(sheetId: string, userId: string): AutorunEntry[] {
  return db.prepare('SELECT * FROM autorun_columns WHERE sheet_id = ? AND user_id = ? ORDER BY created_at')
    .all(sheetId, userId) as AutorunEntry[];
}

// What today's auto-runs of an entry used: dollars (enrichments) and rows
// (an HTTP column's row cap), from the runs it started today.
// aiUsd: a waterfall's AI steps (0 for every other column).
export function usageToday(entryId: string, day = utcDay()): { spentMicro: number; aiUsd: number; rows: number } {
  const r = db.prepare(`SELECT IFNULL(SUM(spent_micro), 0) AS s, IFNULL(SUM(ai_cost_usd), 0) AS a,
      IFNULL(SUM(total_rows), 0) AS n FROM http_runs
    WHERE autorun_id = ? AND autorun_day = ?`).get(entryId, day) as { s: number; a: number; n: number };
  return { spentMicro: r.s, aiUsd: r.a, rows: r.n };
}

// Never replaces a pause the person chose. Its words can carry treg's or a
// run's own text, so what it keeps is redacted.
export function pauseEntry(id: string, reason: string, message: string): void {
  db.prepare(`UPDATE autorun_columns SET paused_reason = ?, paused_message = ?, paused_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ? AND (paused_reason IS NULL OR paused_reason <> 'user')`)
    .run(reason, redactSecrets(message).slice(0, 500), id);
}

// With `reason`, only while that is still the pause (a newer one stays).
export function clearEntryPause(id: string, reason?: string): boolean {
  return db.prepare(`UPDATE autorun_columns SET paused_reason = NULL, paused_message = NULL, paused_at = NULL,
      updated_at = datetime('now') WHERE id = ?${reason === undefined ? '' : ' AND paused_reason = ?'}`)
    .run(...(reason === undefined ? [id] : [id, reason])).changes > 0;
}

// A treg key was saved: auto-runs it stopped for the key try again.
export function clearKeyPauses(userId: string): void {
  db.prepare(`UPDATE autorun_columns SET paused_reason = NULL, paused_message = NULL, paused_at = NULL
    WHERE user_id = ? AND paused_reason IN ('auth', 'no_key', 'balance', 'team_rule')`).run(userId);
}

// An OpenRouter key was saved: waterfall auto-runs OpenRouter stopped (the key
// or a model refused, the balance out) try again.
export function clearAiKeyPauses(userId: string): void {
  db.prepare(`UPDATE autorun_columns SET paused_reason = NULL, paused_message = NULL, paused_at = NULL
    WHERE user_id = ? AND paused_reason IN ('ai_key', 'ai_credits')`).run(userId);
}

// The newest run of a column: what auto-run repeats.
export interface ColumnRunRow { id: string; config: string | null; allow_secrets: number; dest_sheet_id: string | null }
export function newestRunOf(sheetId: string, userId: string, column: string): ColumnRunRow | undefined {
  return db.prepare(`SELECT id, config, allow_secrets, dest_sheet_id FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sheetId, userId, column) as ColumnRunRow | undefined;
}

// The saved keys an HTTP auto-run may fill a {{name}} with: none when the run
// it repeats can't use saved keys (allow_secrets 0, as autorun-start.ts copies it).
export function usableKeyNames(userId: string, allowSecrets: number | null): Set<string> {
  if (allowSecrets === 0) return new Set();
  return new Set(db.prepare('SELECT name FROM api_keys WHERE user_id = ?').pluck().all(userId) as string[]);
}

// The columns a column's runs fill (an enrichment's answer fields, an HTTP
// column's picked fields): auto-run can't read them.
export function columnOutputs(sheetId: string, userId: string, column: string): string[] {
  return db.prepare(`SELECT DISTINCT extracted_column_name FROM http_column_associations
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?`).pluck().all(sheetId, userId, column) as string[];
}

// A run on the column that is active or still clearing its cells.
export function columnRunActive(sheetId: string, userId: string, column: string): boolean {
  return !!db.prepare(`SELECT 1 FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    AND (status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL) LIMIT 1`)
    .get(sheetId, userId, column);
}
