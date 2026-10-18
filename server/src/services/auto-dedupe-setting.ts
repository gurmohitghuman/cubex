// Turning auto-dedupe on, changing it and turning it off: one implementation
// for the app, /api/v1 and MCP. The key column must be one rows arrive with
// (plain, or one a webhook fills): a column Cubex fills later (AI, HTTP,
// enrichment, waterfall, clean, formula, lookup) is empty when a row arrives,
// so nothing would ever match. Another column or match is a new setting,
// whose keys are built in the lookup worker (rows arriving meanwhile are
// checked once they are); keep is changed in place. Turning it on or
// changing it is refused while a run is active on the sheet or another job
// holds it; turning it off never is.
import { db } from '../lib/db';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import { jsonPath } from '../lib/json-path';
import { getColumnTypes, type ColumnType } from '../lib/column-types';
import { cleanColumnFor } from '../lib/clean-columns';
import { logSheetChange } from '../lib/change-log';
import type { DedupeMatch } from '../lib/dedupe/key';
import { AUTO_DEDUPE_KEEPS, isAutoDedupeKeep, type AutoDedupeKeep } from '../lib/auto-dedupe/key';
import { autoDedupeOf, type AutoDedupe } from '../lib/auto-dedupe/store';
import { parseDedupeKey } from './dedupe-input';
import { sheetRunBlock, type BlockingRun } from './autorun-block';
import { driveAutoDedupe } from './auto-dedupe-checks';
import type { RunFail } from './run-shared';

export const AUTO_DEDUPE_RUN_ACTIVE =
  "Auto-dedupe can't be changed while a run is active on this sheet. Stop or finish the run first.";

export interface AutoDedupeFail extends RunFail { busy?: boolean; blockingRun?: BlockingRun }
export interface AutoDedupeArgs { column?: unknown; match?: unknown; phone_country?: unknown; keep?: unknown }

// What get_sheet and the app show. building: the sheet's keys are being read
// (rows arriving meanwhile are checked once they are); waiting_rows: rows
// whose check waits (counted up to WAITING_CAP).
export interface AutoDedupeView {
  column: string; match: DedupeMatch; phone_country: string | null; keep: AutoDedupeKeep;
  state: 'building' | 'on'; waiting_rows: number; shared_rows: number | null; removed_rows: number; since: string;
}

// Every sheet load reads it: counted up to this many.
const WAITING_CAP = 1_000;

function waitingRows(s: AutoDedupe): number {
  const count = db.prepare(`SELECT COUNT(*) FROM (SELECT 1 FROM rows WHERE rowid BETWEEN ? AND ?
    AND +sheet_id = ? AND +user_id = ? LIMIT ?)`).pluck();
  let n = 0;
  for (const r of db.prepare('SELECT lo, hi FROM auto_dedupe_checks WHERE dedupe_id = ?').all(s.id) as
    Array<{ lo: number; hi: number }>) {
    n += count.get(r.lo, r.hi, s.sheet_id, s.user_id, WAITING_CAP - n) as number;
    if (n >= WAITING_CAP) break;
  }
  return n;
}

export function viewOf(s: AutoDedupe): AutoDedupeView {
  return {
    column: s.column_name, match: s.match, phone_country: s.phone_country, keep: s.keep,
    state: s.build_cursor === null ? 'on' : 'building', waiting_rows: waitingRows(s),
    shared_rows: s.shared_rows, removed_rows: s.removed_rows, since: s.created_at,
  };
}

export function autoDedupeView(sheetId: string, userId: string): AutoDedupeView | null {
  const s = autoDedupeOf(sheetId, userId);
  return s ? viewOf(s) : null;
}

const KIND_WORDS: Partial<Record<ColumnType, string>> = {
  'ai-output': 'an AI column', 'ai-data': 'an AI column', 'http-master': 'an HTTP API column',
  'http-extracted': 'an HTTP API column', 'enrich-status': 'an enrichment column', waterfall: 'a waterfall column',
  'waterfall-step': 'a waterfall column', formula: 'a formula column', lookup: 'a lookup column',
};

// Why a column can't be the key, or null when it can.
function filledBy(sheetId: string, userId: string, column: string): string | null {
  const type = getColumnTypes(sheetId, userId)[column];
  if (!type || type === 'webhook-mapped') return null;
  const q = `"${column}"`;
  if (type === 'webhook-source') return `${q} is the webhook's marker column. Pick a column the webhook fills.`;
  if (type === 'clean') {
    const source = cleanColumnFor(sheetId, userId, column)?.source_column;
    return `${q} is a clean data column, filled after rows arrive. Pick the column it cleans`
      + `${source ? ` ("${source}")` : ''} instead, with the match that cleans it the same way `
      + '(email, domain, phone, company or person_name).';
  }
  return `${q} is ${KIND_WORDS[type] ?? 'a column Cubex fills'}, filled after rows arrive, so new rows don't `
    + 'have it yet. Pick a column rows arrive with.';
}

function guard(sheetId: string, userId: string): AutoDedupeFail | null {
  const what = sheetBusyWith(sheetId);
  if (what) return { fail: 'conflict', message: busyMessage(what), busy: true };
  const block = sheetRunBlock(sheetId, userId, AUTO_DEDUPE_RUN_ACTIVE);
  return block ? { fail: 'conflict', message: block.message, blockingRun: block.run } : null;
}

const MATCH_WORDS: Record<DedupeMatch, string> = {
  text: 'as text', email: 'as an email', domain: 'as a domain', phone: 'as a phone number',
  company: 'as a company name', person_name: "as a person's name",
};

// Turns it on, or changes it. A field left out keeps what the setting has
// (a new setting: match text, keep oldest).
export function setAutoDedupe(
  userId: string, sheetId: string, args: AutoDedupeArgs,
): { ok: AutoDedupeView } | AutoDedupeFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const have = autoDedupeOf(sheetId, userId);
  const column = args.column ?? have?.column_name;
  if (typeof column !== 'string' || !column) {
    return { fail: 'bad_request', message: 'Name the key column: column is required.' };
  }
  const sameColumn = have?.column_name === column;
  const item: Record<string, unknown> = { column, match: args.match ?? (sameColumn ? have!.match : undefined) };
  const country = args.phone_country ?? (sameColumn && args.match === undefined ? have!.phone_country : undefined);
  if (country !== undefined && country !== null) item.phone_country = country;
  const key = parseDedupeKey(item, getSheetColumns(sheetId, userId, false));
  if ('fail' in key) return key;
  const why = filledBy(sheetId, userId, column);
  if (why) return { fail: 'bad_request', message: why };
  const keep = args.keep ?? have?.keep ?? 'oldest';
  if (!isAutoDedupeKeep(keep)) {
    return { fail: 'bad_request', message: `keep must be ${AUTO_DEDUPE_KEEPS.join(' or ')}.` };
  }

  let fail: AutoDedupeFail | null = null;
  let built = false;
  db.transaction(() => {
    fail = guard(sheetId, userId);
    if (fail) return;
    const now = autoDedupeOf(sheetId, userId);
    const country = key.country ?? null;
    if (now && now.column_name === key.column && now.match === key.match && now.phone_country === country) {
      if (now.keep === keep) return;
      db.prepare("UPDATE auto_dedupe SET keep = ?, updated_at = datetime('now') WHERE id = ?").run(keep, now.id);
      logSheetChange(sheetId, userId, 'auto_dedupe', `Auto-dedupe now keeps the ${keep} row`,
        { column: key.column, detail: { keep } });
      return;
    }
    if (now) db.prepare('DELETE FROM auto_dedupe WHERE id = ?').run(now.id);
    const id = db.prepare(`INSERT INTO auto_dedupe (user_id, sheet_id, column_name, path, match, phone_country, keep)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, sheetId, key.column, jsonPath(key.column), key.match, country, keep)
      .lastInsertRowid;
    // Checks that were waiting are made under the new match once it is built;
    // on another column they go (its rows weren't checked on arrival either).
    if (now && now.column_name === key.column) {
      db.prepare(`INSERT INTO auto_dedupe_checks (dedupe_id, lo, hi, retry_at)
        SELECT ?, lo, hi, 0 FROM auto_dedupe_checks WHERE dedupe_id = ?`).run(id, now.id);
    }
    built = true;
    logSheetChange(sheetId, userId, 'auto_dedupe',
      `${now ? 'Auto-dedupe now matches' : 'Turned on auto-dedupe: rows match'} on "${key.column}" `
      + `${MATCH_WORDS[key.match]}, keeping the ${keep} row`,
      { column: key.column, detail: { match: key.match, keep } });
  }).immediate();
  if (fail) return fail;
  if (built) driveAutoDedupe(sheetId, userId);
  return { ok: viewOf(autoDedupeOf(sheetId, userId)!) };
}

// Turning it off is never refused: it only stops removals (a check under way
// finds no setting and stops), so it is the way out while a run goes on.
export function turnOffAutoDedupe(userId: string, sheetId: string): { ok: { off: true } } | AutoDedupeFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  db.transaction(() => {
    const now = autoDedupeOf(sheetId, userId);
    if (!now) return;
    db.prepare('DELETE FROM auto_dedupe WHERE id = ?').run(now.id);
    logSheetChange(sheetId, userId, 'auto_dedupe', 'Turned off auto-dedupe', { column: now.column_name });
  }).immediate();
  return { ok: { off: true } };
}
