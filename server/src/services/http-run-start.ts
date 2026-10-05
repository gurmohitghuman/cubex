// HTTP run start — the flow behind POST /api/http/run, extracted verbatim so
// the UI route, /api/v1 and the MCP tools share one implementation. Additions
// for the programmatic surfaces: optional
// row-subset targeting, and the run-level allow_secrets policy (migration 034
// — false freezes saved-api_keys resolution OFF for this run and its reruns).
//
// Load-bearing: cap check + column_order + run row + associations stay in ONE
// immediate txn, inside the sheet's busy window (services/run-seed.ts), which
// then seeds the placeholders in slices and queues the run, after the start
// has answered; a failure there fails the run and clears them.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import {
  appendColumnsToOrder, countColumnsAndRows, getSheetColumns, verifySheetOwnership,
} from '../lib/sql-helpers';
import { existingRowIndexes } from '../lib/run-rows';
import { type HTTPAPIConfig } from '../lib/http-request';
import { validateHttpRunColumns } from '../lib/http-run-validate';
import { httpTemplateError } from '../lib/http-template-validate';
import { enqueueHTTPRun, enqueueHTTPRerun } from '../queue';
import { RunFail } from './run-shared';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { asRunStart, seedThenEnqueue, sheetRowSpan } from './run-seed';

export interface HttpRunStartParams {
  sheetId: string;
  config: HTTPAPIConfig;
  masterColumnName?: string;
  // v1/MCP only: run just these row_index values. undefined = full sheet.
  targetRowIndexes?: number[];
  // Run-level saved-key policy. true for UI (cookie) starts; PAT starts pass
  // whether the token holds the 'secrets' scope. Frozen onto the run row.
  allowSecrets: boolean;
}

export type HttpRunStartOutcome =
  | { ok: {
      runId: string; masterColumn: string; mappedColumns: string[]; targetCount: number;
    } }
  | RunFail;

export async function startHttpRun(userId: string, p: HttpRunStartParams): Promise<HttpRunStartOutcome> {
  // A sheet busy sorting, importing or rewriting a column takes no run (lib/sheet-busy.ts).
  const busy = sheetBusyWith(p.sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  const config = p.config;
  // responseMapping must be an array — a malformed direct payload (the UI
  // always sends one) would otherwise reach config.responseMapping.map() and
  // throw a 500. Clean failure instead.
  if (!config || !Array.isArray(config.responseMapping)) {
    return { fail: 'bad_request', message: 'config.responseMapping must be an array' };
  }
  // Bound the mapping count BEFORE the O(n²) duplicate/JSONPath validation and
  // the giant json_set prepare. A run can create at most MAX_COLUMNS_PER_SHEET
  // columns anyway, so a larger mapping is definitionally over-cap — reject it
  // immediately instead of burning CPU (or hitting SQLite's param limit → 500)
  // on a hostile 2MB body full of unique mappings.
  if (config.responseMapping.length > MAX_COLUMNS_PER_SHEET) {
    return {
      fail: 'cap',
      message: `Too many response mappings (max ${MAX_COLUMNS_PER_SHEET}). A sheet allows at most ${MAX_COLUMNS_PER_SHEET} columns.`,
    };
  }
  if (!verifySheetOwnership(p.sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const templateError = httpTemplateError(config.requestConfig, getSheetColumns(p.sheetId, userId, false), userId);
  if (templateError) return { fail: 'bad_request', message: templateError };

  // Every existing row (a count and the last row_index, never the list: the
  // placeholders go in by range), or exactly the caller's rows, all of which
  // must exist, so deleted rows never resurrect.
  const span = sheetRowSpan(p.sheetId, userId);
  if (span.count === 0) return { fail: 'bad_request', message: 'No data available to process' };
  let targets: number[] | null = null;
  if (p.targetRowIndexes !== undefined) {
    targets = Array.from(new Set(p.targetRowIndexes)).sort((a, b) => a - b);
    if (targets.length === 0 || existingRowIndexes(p.sheetId, userId, targets).length !== targets.length) {
      return { fail: 'bad_request', message: 'Target rows resolved to no existing rows' };
    }
  }
  const targetCount = targets ? targets.length : span.count;

  // Default to a per-second-unique master name so two unnamed runs on the same
  // sheet don't both default to "HTTP API <date>" and collide.
  const proposedMaster = p.masterColumnName
    || `HTTP API ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

  // ONE shared validator: sanitizes the master + mapping names, then rejects
  // case-insensitive mapping dups, master↔mapping collisions, and
  // case-insensitive conflicts with existing columns (Bug 5).
  const validation = validateHttpRunColumns(
    p.sheetId, userId, config.responseMapping, proposedMaster, true,
  );
  if (!validation.ok) return { fail: 'bad_request', message: validation.error! };

  // Use the SANITIZED names everywhere downstream.
  config.responseMapping.forEach((m, i) => { m.columnName = validation.sanitizedMappingColumns![i]; });
  const finalMasterColumnName = validation.sanitizedMaster!;

  const runId = uuidv4();
  const allColumns = [finalMasterColumnName, ...config.responseMapping.map(m => m.columnName)];

  // Cap check + mutation in ONE immediate-mode transaction — two concurrent
  // starts could otherwise both pass the cap check and both insert their full
  // set of master+extracted columns.
  return asRunStart(p.sheetId, async (): Promise<HttpRunStartOutcome> => {
    let capExceededCount = -1;
    db.transaction(() => {
      const { columns: currentCols } = countColumnsAndRows(p.sheetId, userId);
      const masterExists = getSheetColumns(p.sheetId, userId, false).includes(finalMasterColumnName);
      const newColsNeeded = (masterExists ? 0 : 1) + config.responseMapping.length;
      if (currentCols + newColsNeeded > MAX_COLUMNS_PER_SHEET) { capExceededCount = newColsNeeded; return; }

      appendColumnsToOrder(p.sheetId, userId, allColumns);
      db.prepare(`
        INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name, target_rows, allow_secrets, placeholder_work)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, 'seeding')
      `).run(
        runId, p.sheetId, userId, JSON.stringify(config), targetCount,
        finalMasterColumnName, targets ? JSON.stringify(targets) : null,
        p.allowSecrets ? 1 : 0,
      );

      const insertAssoc = db.prepare(`
        INSERT INTO http_column_associations (
          id, sheet_id, user_id, master_column_name, extracted_column_name, run_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const mapping of config.responseMapping) {
        insertAssoc.run(uuidv4(), p.sheetId, userId, finalMasterColumnName, mapping.columnName, runId);
      }
    }).immediate();

    if (capExceededCount >= 0) return {
      fail: 'cap',
      message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This HTTP run needs ${capExceededCount} new columns — delete unused columns first.`,
    };

    // Subset starts dispatch as a RERUN job — it iterates exactly target_rows
    // and scopes the stuck-row finalize check to them.
    seedThenEnqueue({
      kind: 'http', runId, sheetId: p.sheetId, userId, columns: allColumns,
      targets, lastRow: span.lastRow,
      enqueue: () => (targets ? enqueueHTTPRerun(runId, targets) : enqueueHTTPRun(runId)),
    });

    return {
      ok: {
        runId, masterColumn: finalMasterColumnName,
        mappedColumns: config.responseMapping.map(m => m.columnName),
        targetCount,
      },
    };
  });
}
