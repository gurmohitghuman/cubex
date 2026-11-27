// A sheet searched before the Open roles count read the domain column (v0.8.48): its roles' Domain is the website
// cell as written then, which the domain column's keys don't match (services/open-roles-lookups.ts). Each role's
// Domain is cleaned in place by the same cleaner before the count is pointed at the domain column, so those roles keep
// counting. A whole-sheet rewrite, so as CLAUDE.md asks: under the Open roles sheet's busy lock (a sort or another
// change can't move rows under it), in storage (rowid) order, in checkpointed slices. A cell the cleaner can't read
// stays as it is; cleaning a domain gives it back unchanged, so a conversion cut short (a restart) is finished by the
// next look (the next run's, or boot's: open-roles-watch.ts), which finds the count still on the old column.
import { db } from '../lib/db';
import { parseRowData } from '../lib/sql-helpers';
import { sheetRowIds, eachRowIdSlice } from '../lib/row-order';
import { withLiveSheetBusy, sheetGone } from '../lib/sheet-busy';
import { jsonPath } from '../lib/json-path';
import { cellOf } from '../lib/row-cell';
import { cleanDomain } from '../lib/clean/domain';
import { markAutorunInputs } from '../lib/autorun-mark';
import { logSheetChange, countOf } from '../lib/change-log';
import { writeColumnDescription } from '../lib/column-descriptions';
import { OPEN_ROLES_WORDS, ROLE_COLUMNS } from '../lib/hiring/names';

// The roles whose Domain was cleaned, or why it couldn't start now (the sheet busy or gone).
export async function cleanRolesDomains(userId: string, rolesSheetId: string)
  : Promise<{ changed: number } | { held: string }> {
  const out = await withLiveSheetBusy(rolesSheetId, userId, 'writing each role\'s Domain as its domain', async () => {
    const ids = await sheetRowIds(rolesSheetId, userId);
    const read = db.prepare(`SELECT rowid AS rid, data FROM rows WHERE rowid IN (SELECT value FROM json_each(?))
      AND +sheet_id = ? AND +user_id = ? ORDER BY rowid`);
    const set = db.prepare(`UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now') WHERE rowid = ?`);
    const path = jsonPath(ROLE_COLUMNS.domain);
    let changed = 0;
    await eachRowIdSlice(ids, idsJson => {
      const rowids: number[] = [];
      for (const r of read.all(idsJson, rolesSheetId, userId) as Array<{ rid: number; data: string }>) {
        const was = String(cellOf(parseRowData(r.data) as Record<string, string>, ROLE_COLUMNS.domain) ?? '').trim();
        const now = was ? cleanDomain(was) : '';
        if (now && now !== was) { set.run(path, now, r.rid); rowids.push(r.rid); }
      }
      // A clean or formula column on the roles sheet reading Domain follows the rows written.
      if (rowids.length) markAutorunInputs(rolesSheetId, userId, [ROLE_COLUMNS.domain], { rowids });
      changed += rowids.length;
    }, { checkpointed: true });
    if (changed) {
      db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`).run(rolesSheetId, userId);
      logSheetChange(rolesSheetId, userId, 'clean_column', `Wrote the Domain of ${countOf(changed, 'role')} as its `
        + 'domain, so the Open roles count beside matches them',
      { detail: { column: ROLE_COLUMNS.domain, rows: changed } });
    }
    // Its words now say what Domain holds.
    db.prepare('UPDATE sheets SET description = ? WHERE id = ? AND user_id = ?')
      .run(OPEN_ROLES_WORDS.sheet, rolesSheetId, userId);
    writeColumnDescription(rolesSheetId, userId, ROLE_COLUMNS.domain, OPEN_ROLES_WORDS.roleDomain);
    return { changed };
  });
  if (sheetGone(out)) return { held: 'the Open roles sheet is gone' };
  return 'busy' in out ? { held: out.busy } : out;
}
