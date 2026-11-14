// What an MCP error's next step reads (next-steps.ts): the caller's own sheets, tables, runs and setups,
// and a sheet's column names. Every read is bounded: the newest LOOK_AT of a kind, through the user's
// index, and a sheet's stored column list; never the rows.
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { verifyTableOwnership } from '../lib/sheet-crud-helpers';
import { enrichConfigOf } from '../services/run-status-enrich';
import { waterfallConfigOf } from '../lib/waterfall/config';
import { stepColumns } from '../lib/setups/spec';
import { getSetup } from '../services/setup-library';

// How many of a kind a close match is looked for among, newest first.
export const LOOK_AT = 500;

export interface Named { id: string; name: string }
export interface SheetNamed extends Named { table: string }
// trash_ids in the order restore_from_trash takes them: a table before a sheet of it.
export interface InTrash { name: string; table?: string; trash_ids: number[] }

export const liveSheets = (userId: string): SheetNamed[] => db.prepare(`
  SELECT s.id, s.name, t.name AS "table" FROM sheets s JOIN tables t ON t.id = s.table_id
  WHERE s.user_id = ? AND s.trash_id IS NULL AND t.trash_id IS NULL ORDER BY s.rowid DESC LIMIT ?
`).all(userId, LOOK_AT) as SheetNamed[];

export const liveTables = (userId: string): Named[] => db.prepare(
  'SELECT id, name FROM tables WHERE user_id = ? AND trash_id IS NULL ORDER BY rowid DESC LIMIT ?',
).all(userId, LOOK_AT) as Named[];

export const savedSetups = (userId: string): Named[] => db.prepare(
  'SELECT id, name FROM setups WHERE user_id = ? ORDER BY rowid DESC LIMIT ?',
).all(userId, LOOK_AT) as Named[];

// Whether the caller has a live one with this id, looked up by id (older than the LOOK_AT newest too).
export const hasSheet = (userId: string, id: string) => !!verifySheetOwnership(id, userId);
export const hasTable = (userId: string, id: string) => verifyTableOwnership(id, userId);
export const hasSetup = (userId: string, id: string) =>
  !!db.prepare('SELECT 1 FROM setups WHERE id = ? AND user_id = ?').get(id, userId);

// The caller's sheet with this id when it, or its table, is in the trash. A sheet put there before its
// table needs both back, the table first (a sheet's restore is refused while its table is in the trash).
export function sheetInTrash(userId: string, id: string): InTrash | null {
  const row = db.prepare(`
    SELECT s.name, t.name AS "table", t.trash_id AS of_table, s.trash_id AS of_sheet
    FROM sheets s JOIN tables t ON t.id = s.table_id WHERE s.id = ? AND s.user_id = ?
  `).get(id, userId) as { name: string; table: string; of_table: number | null; of_sheet: number | null } | undefined;
  const ids = [...new Set([row?.of_table, row?.of_sheet].filter((n): n is number => n != null))];
  return row && ids.length ? { name: row.name, table: row.table, trash_ids: ids } : null;
}

export function tableInTrash(userId: string, id: string): InTrash | null {
  const row = db.prepare('SELECT name, trash_id FROM tables WHERE id = ? AND user_id = ?').get(id, userId) as
    { name: string; trash_id: number | null } | undefined;
  return row?.trash_id != null ? { name: row.name, trash_ids: [row.trash_id] } : null;
}

// The columns the caller's saved setup makes and the ones it reads (its inputs); null when there is no
// such setup. One setup, by its key.
export function setupColumns(userId: string, id: string): { makes: string[]; reads: string[] } | null {
  const setup = getSetup(userId, id);
  return setup ? { makes: setup.spec.steps.flatMap(stepColumns), reads: setup.spec.inputs } : null;
}

// A live sheet's columns as stored (sheets.column_order); null for a sheet that has no stored list yet,
// whose columns only its rows hold.
export function storedColumns(userId: string, sheetId: string): string[] | null {
  const raw = db.prepare('SELECT column_order FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL')
    .pluck().get(sheetId, userId) as string | null | undefined;
  try {
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : null;
  } catch {
    return null;
  }
}

export type RunKind = 'ai' | 'http' | 'enrichment' | 'waterfall';
export interface RunNamed { id: string; kind: RunKind; column: string | null; sheet: string | null }

// An HTTP API run's own kind: its config says whether it is an enrichment or a waterfall.
const httpKind = (config: string | null): RunKind =>
  enrichConfigOf(config) ? 'enrichment' : waterfallConfigOf(config) ? 'waterfall' : 'http';

// The caller's run with this id, of any kind.
export function runOf(userId: string, id: string): RunNamed | null {
  const ai = db.prepare(`SELECT r.id, r.column_name AS "column", s.name AS sheet FROM ai_runs r
    LEFT JOIN sheets s ON s.id = r.sheet_id WHERE r.id = ? AND r.user_id = ?`).get(id, userId) as
    Omit<RunNamed, 'kind'> | undefined;
  if (ai) return { ...ai, kind: 'ai' };
  const http = db.prepare(`SELECT r.id, r.master_column_name AS "column", s.name AS sheet, r.config FROM http_runs r
    LEFT JOIN sheets s ON s.id = r.sheet_id WHERE r.id = ? AND r.user_id = ?`).get(id, userId) as
    (Omit<RunNamed, 'kind'> & { config: string | null }) | undefined;
  if (!http) return null;
  const { config, ...rest } = http;
  return { ...rest, kind: httpKind(config) };
}

// The caller's newest run ids of each table, for a close match by id; runOf then names the kind.
export function recentRunIds(userId: string): string[] {
  const newest = (table: string) => db.prepare(
    `SELECT id FROM ${table} WHERE user_id = ? ORDER BY rowid DESC LIMIT ?`,
  ).pluck().all(userId, LOOK_AT) as string[];
  return [...newest('ai_runs'), ...newest('http_runs')];
}
