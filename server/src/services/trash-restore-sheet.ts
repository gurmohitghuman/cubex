// Restoring a deleted sheet or table (trash-sheets.ts kept it whole, hidden):
// it shows again as it was, with its rows, columns, runs, views and webhook.
// A sheet goes back as its table's last tab, under its name, or "<name>
// (restored)" when a sheet of the table took the name meanwhile (a table the
// same among tables); a sheet whose table is in the trash waits for the table.
// Lookups that look in it start again. One small transaction: nothing moves.
import { db } from '../lib/db';
import { MAX_SHEET_NAME_LENGTH, MAX_TABLE_NAME_LENGTH } from '../lib/constants';
import { logSheetChange } from '../lib/change-log';
import { lookupsFailedOnTrash, restartLookupsInto } from '../lib/trash/lookups';
import { withoutChangeLog } from '../lib/change-log';
import { lookupInputOf, startLookupColumn } from './lookup-column';
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

export function restoreSheetItem(userId: string, itemId: number): { ok: SheetRestored } | RestoreFail {
  const item = getTrashItem(itemId, userId);
  if (!item || item.kind === 'rows') return { fail: 'not_found', message: 'Nothing in the trash with that id.' };
  if (item.state !== 'kept') return { fail: 'conflict', message: 'This is being deleted.' };
  return item.kind === 'sheet' ? restoreSheet(userId, item) : restoreTable(userId, item);
}

function restoreSheet(userId: string, item: TrashItem): { ok: SheetRestored } | RestoreFail {
  const sheetId = item.sheet_id!;
  const table = db.prepare('SELECT name, trash_id FROM tables WHERE id = ? AND user_id = ?')
    .get(item.table_id, userId) as { name: string; trash_id: number | null } | undefined;
  if (!table) return { fail: 'not_found', message: 'The table this sheet was in is gone.' };
  if (table.trash_id !== null) {
    return { fail: 'conflict', message: `Its table "${table.name}" is in the trash. Restore the table first.` };
  }
  let out: SheetRestored | null = null;
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
    logSheetChange(sheetId, userId, 'sheet_restored',
      name === sheet.name ? 'Restored the sheet from the trash' : `Restored the sheet from the trash as "${name}"`,
      { detail: { trash_id: item.id } });
    out = { trash_id: item.id, kind: 'sheet', table_id: item.table_id, sheet_id: sheetId, name,
      renamed: name !== sheet.name, state: 'restored' };
  }).immediate();
  if (out) refillLookups(userId, [sheetId]);
  return out ? { ok: out } : { fail: 'conflict', message: 'This is being deleted.' };
}

// Lookups whose fill stopped while the sheet was in the trash look up again,
// in the background, as "Look up again" would (no change-log line of their own).
function refillLookups(userId: string, sheetIds: string[]): void {
  for (const rec of lookupsFailedOnTrash(sheetIds, userId)) {
    const failed = (why: unknown) => console.error(`Looking up "${rec.column_name}" again failed:`, why);
    withoutChangeLog(() => startLookupColumn(userId, rec.sheet_id, lookupInputOf(rec)))
      .then(out => { if ('fail' in out) failed(out.message); })
      .catch(failed);
  }
}

function restoreTable(userId: string, item: TrashItem): { ok: SheetRestored } | RestoreFail {
  let out: SheetRestored | null = null;
  let sheets: string[] = [];
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
    for (const id of sheets) {
      logSheetChange(id, userId, 'sheet_restored', 'Restored with its table from the trash',
        { detail: { trash_id: item.id } });
    }
    out = { trash_id: item.id, kind: 'table', table_id: item.table_id, sheet_id: null, name,
      renamed: name !== table.name, state: 'restored' };
  }).immediate();
  if (out) refillLookups(userId, sheets);
  return out ? { ok: out } : { fail: 'conflict', message: 'This is being deleted.' };
}
