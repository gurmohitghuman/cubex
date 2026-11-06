// Restoring a deleted sheet or table (trash-sheets.ts kept it whole, hidden):
// it shows again as it was, with its rows, columns, runs, views and webhook.
// A sheet goes back as its table's last tab, under its name, or "<name>
// (restored)" when a sheet of the table took the name meanwhile (a table the
// same among tables); a sheet whose table is in the trash waits for the table.
// Lookups whose fill failed while the sheet they look in was in the trash fill
// again (those that look in it, and those on it whose other sheet is live), and
// so do its own fills the trash stopped, after the request (startRestored). One
// small transaction: nothing moves.
import { db } from '../lib/db';
import { MAX_SHEET_NAME_LENGTH, MAX_TABLE_NAME_LENGTH } from '../lib/constants';
import { logSheetChange } from '../lib/change-log';
import { lookupsFillAgain, restartLookupsInto, type LookupRefill } from '../lib/trash/lookups';
import { whenSheetFree } from '../lib/sheet-busy';
import { runDerivedFill } from './derived-fill';
import { LOOKUP_FILLING, lookupKind } from './lookup-kind';
import { lookupFillStarted } from './lookup-fill-changes';
import { resumeFillsBackFromTrash } from './derived-fill-parked';
import { getTrashItem, type TrashItem } from '../lib/trash/store';
import type { RestoreFail } from './trash-restore';

export interface SheetRestored {
  trash_id: number; kind: 'sheet' | 'table'; table_id: string; sheet_id: string | null;
  name: string; renamed: boolean; state: 'restored';
}

// The name itself when free, else "<name> (restored)", "(restored 2)"…, cut to fit.
function freeName(name: string, max: number, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  for (let i = 1; ; i++) {
    const tail = i === 1 ? ' (restored)' : ` (restored ${i})`;
    const candidate = `${name.slice(0, Math.max(1, max - tail.length)).trimEnd()}${tail}`;
    if (!taken(candidate)) return candidate;
  }
}

function claim(item: TrashItem): boolean {
  return db.prepare("DELETE FROM trash_items WHERE id = ? AND state = 'kept'").run(item.id).changes > 0;
}

// What a restore starts again: the restored sheets (their fills the trash
// parked) and the lookups it set to fill again (lookupsFillAgain).
export interface Restarted { sheets: string[]; lookups: LookupRefill[] }
export const nothingRestarted = (): Restarted => ({ sheets: [], lookups: [] });

// `later`: the caller collects what it starts again and calls startRestored
// once its whole request is done (restoreFromTrash); left out, it starts after
// this request.
export function restoreSheetItem(
  userId: string, itemId: number, later?: Restarted,
): { ok: SheetRestored } | RestoreFail {
  const item = getTrashItem(itemId, userId);
  if (!item || item.kind === 'rows') return { fail: 'not_found', message: 'Nothing in the trash with that id.' };
  if (item.state !== 'kept') return { fail: 'conflict', message: 'This is being deleted.' };
  const restarted = later ?? nothingRestarted();
  const out = item.kind === 'sheet' ? restoreSheet(userId, item, restarted) : restoreTable(userId, item, restarted);
  if (!later) startRestored(restarted);
  return out;
}

// After the request that restored (so nothing it restores next, a batch of a
// sheet's rows, is refused as busy): each lookup set to fill again takes its
// sheet once it is free, as a fill resumed at boot does, then the fills the
// trash parked go on, each once its sheet is free. Lookups go first, so rows
// restored with them are looked up in the same fill. A lookup whose own sheet
// is in the trash by then is parked (derived-fill.ts) until that is restored.
export function startRestored(r: Restarted): void {
  if (r.sheets.length === 0 && r.lookups.length === 0) return;
  setImmediate(() => {
    for (const l of r.lookups) {
      lookupFillStarted(l.id);
      whenSheetFree(l.sheet_id, LOOKUP_FILLING, () => runDerivedFill(lookupKind, l.id))
        .catch(err => console.error(`Looking up again on sheet ${l.sheet_id} failed:`, err));
    }
    resumeFillsBackFromTrash(r.sheets);
  });
}

function restoreSheet(userId: string, item: TrashItem, later: Restarted): { ok: SheetRestored } | RestoreFail {
  const sheetId = item.sheet_id!;
  const table = db.prepare('SELECT name, trash_id FROM tables WHERE id = ? AND user_id = ?')
    .get(item.table_id, userId) as { name: string; trash_id: number | null } | undefined;
  if (!table) return { fail: 'not_found', message: 'The table this sheet was in is gone.' };
  if (table.trash_id !== null) {
    return { fail: 'conflict', message: `Its table "${table.name}" is in the trash. Restore the table first.` };
  }
  let out: SheetRestored | null = null;
  let refills: LookupRefill[] = [];
  db.transaction(() => {
    const sheet = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ? AND trash_id = ?')
      .get(sheetId, userId, item.id) as { name: string } | undefined;
    if (!sheet || !claim(item)) return;
    const taken = db.prepare(`SELECT 1 FROM sheets WHERE table_id = ? AND user_id = ? AND trash_id IS NULL
      AND LOWER(name) = LOWER(?)`).pluck();
    const name = freeName(sheet.name, MAX_SHEET_NAME_LENGTH, n => !!taken.get(item.table_id, userId, n));
    const last = db.prepare(`SELECT MAX(position) FROM sheets WHERE table_id = ? AND user_id = ?
      AND trash_id IS NULL`).pluck().get(item.table_id, userId) as number | null;
    db.prepare(`UPDATE sheets SET trash_id = NULL, name = ?, position = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(name, (last ?? -1) + 1, sheetId, userId);
    restartLookupsInto([sheetId]);
    refills = lookupsFillAgain([sheetId], userId);
    logSheetChange(sheetId, userId, 'sheet_restored',
      name === sheet.name ? 'Restored the sheet from the trash' : `Restored the sheet from the trash as "${name}"`,
      { detail: { trash_id: item.id } });
    out = { trash_id: item.id, kind: 'sheet', table_id: item.table_id, sheet_id: sheetId, name,
      renamed: name !== sheet.name, state: 'restored' };
  }).immediate();
  if (out) { later.sheets.push(sheetId); later.lookups.push(...refills); }
  return out ? { ok: out } : { fail: 'conflict', message: 'This is being deleted.' };
}

function restoreTable(userId: string, item: TrashItem, later: Restarted): { ok: SheetRestored } | RestoreFail {
  let out: SheetRestored | null = null;
  let sheets: string[] = [];
  let refills: LookupRefill[] = [];
  db.transaction(() => {
    const table = db.prepare('SELECT name FROM tables WHERE id = ? AND user_id = ? AND trash_id = ?')
      .get(item.table_id, userId, item.id) as { name: string } | undefined;
    if (!table || !claim(item)) return;
    const taken = db.prepare('SELECT 1 FROM tables WHERE user_id = ? AND trash_id IS NULL AND name = ?').pluck();
    const name = freeName(table.name, MAX_TABLE_NAME_LENGTH, n => !!taken.get(userId, n));
    db.prepare(`UPDATE tables SET trash_id = NULL, name = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(name, item.table_id, userId);
    // Its sheets that went with it (one deleted on its own before stays in the trash).
    sheets = db.prepare('SELECT id FROM sheets WHERE trash_id = ? AND user_id = ?').pluck()
      .all(item.id, userId) as string[];
    db.prepare('UPDATE sheets SET trash_id = NULL WHERE trash_id = ? AND user_id = ?').run(item.id, userId);
    restartLookupsInto(sheets);
    refills = lookupsFillAgain(sheets, userId);
    for (const id of sheets) {
      logSheetChange(id, userId, 'sheet_restored', 'Restored with its table from the trash',
        { detail: { trash_id: item.id } });
    }
    out = { trash_id: item.id, kind: 'table', table_id: item.table_id, sheet_id: null, name,
      renamed: name !== table.name, state: 'restored' };
  }).immediate();
  if (out) { later.sheets.push(...sheets); later.lookups.push(...refills); }
  return out ? { ok: out } : { fail: 'conflict', message: 'This is being deleted.' };
}
