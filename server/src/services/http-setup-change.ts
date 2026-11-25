// A new setup for an HTTP API column saved without a run (services/http-run-start.ts hands it here once its
// request, rule and column names pass): written as the column's setup (services/column-setup-save.ts); its
// next rerun, run or auto-run uses it. A new column is made empty, set up. A start that runs never takes an
// existing column's name: one mistyped name would replace a column's setup and run every row again.
import { db } from '../lib/db';
import { getSheetColumns, sanitizeColumnName } from '../lib/sql-helpers';
import { sheetColumnKinds } from '../lib/column-types';
import { type HTTPAPIConfig } from '../lib/http-request';
import { saveHttpSetup } from './column-setup-save';
import { httpRunActiveOn } from './http-rerun-checks';
import type { HttpRunStartOutcome, HttpRunStartParams } from './http-run-start';

// The columns of an existing plain HTTP API column (itself, then those its runs fill), or null for a name that
// isn't one (new, or another kind of column: the start's name check refuses that one).
export function plainHttpColumn(
  sheetId: string, userId: string, name: string,
): { master: string; own: string[] } | null {
  const listed = getSheetColumns(sheetId, userId, false);
  const master = listed.includes(name) ? name : sanitizeColumnName(name);
  if (!listed.includes(master) || sheetColumnKinds(sheetId, userId).types[master] !== 'http-master') return null;
  const linked = db.prepare(`SELECT DISTINCT extracted_column_name FROM http_column_associations
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?`).pluck().all(sheetId, userId, master) as string[];
  return { master, own: [master, ...linked] };
}

// A run start naming an existing HTTP API column: refused, saying how to change its setup.
export const httpColumnExists = (master: string): string => `Column "${master}" already has an HTTP API setup. `
  + 'To change it, save the new setup without running (save_only, or Edit in the app), then rerun the column.';

export function saveHttpColumnSetup(
  userId: string, p: HttpRunStartParams, config: HTTPAPIConfig, master: string, existing: boolean,
  runIf: string | null,
): HttpRunStartOutcome {
  if (existing) {
    const active = httpRunActiveOn(p.sheetId, userId, master);
    if (active) return active;
  }
  const mapped = config.responseMapping.map(m => m.columnName);
  const saved = saveHttpSetup(p.sheetId, userId, 'http', master, mapped, {
    kind: 'http', mode: 'http', config, allowSecrets: p.allowSecrets ? 1 : 0, destSheetId: null, extracted: mapped,
  }, runIf);
  if ('fail' in saved) return saved;
  return { ok: { runId: saved.ok.setupId, saved: true, masterColumn: master, mappedColumns: mapped, targetCount: 0,
    runIf } };
}
