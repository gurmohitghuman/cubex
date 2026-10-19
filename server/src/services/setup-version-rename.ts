// A column rename reaching the setup versions (setup_versions, migration 043),
// inside the rename's transaction (services/column-rename.ts). The rewrites
// themselves are pure: lib/setup-versions/rename.ts.
import { db } from '../lib/db';
import { parseVersionSpec } from '../lib/setup-versions/spec';
import { renameNeedle, renameOtherSheetColumn, renameVersionColumn } from '../lib/setup-versions/rename';

// Inside a column rename's transaction: the sheet's versions follow the new
// name, and so do other sheets' versions whose lookups, waterfall lookup steps
// or list enrichments name this sheet's column. Only versions whose text can
// name the column are read and parsed (renameNeedle, in SQL); the others, up to
// MAX_SETUP_VERSION_BYTES each, are scanned in place and never leave SQLite.
export function renameSetupVersionRefs(sheetId: string, userId: string, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const save = db.prepare(`UPDATE setup_versions SET spec = ? WHERE id = ?`);
  const needle = renameNeedle(oldName);
  const names = needle === null ? ''
    : `AND (spec LIKE ?${needle.also.map(() => ' OR instr(spec, ?) > 0').join('')})`;
  const nameArgs = needle === null ? [] : [needle.like, ...needle.also];
  const own = db.prepare(`SELECT id, spec FROM setup_versions WHERE sheet_id = ? AND user_id = ? ${names}`)
    .all(sheetId, userId, ...nameArgs) as Array<{ id: string; spec: string }>;
  for (const r of own) {
    const spec = parseVersionSpec(r.spec);
    if (spec && renameVersionColumn(spec, oldName, newName)) save.run(JSON.stringify(spec), r.id);
  }
  // Another sheet's version names this one by its id; idx_setup_versions_user narrows to the account.
  const others = db.prepare(`SELECT id, spec FROM setup_versions WHERE user_id = ? AND sheet_id != ?
    AND instr(spec, ?) > 0 ${names}`).all(userId, sheetId, sheetId, ...nameArgs) as Array<{ id: string; spec: string }>;
  for (const r of others) {
    const spec = parseVersionSpec(r.spec);
    if (spec && renameOtherSheetColumn(spec, sheetId, oldName, newName)) save.run(JSON.stringify(spec), r.id);
  }
}
