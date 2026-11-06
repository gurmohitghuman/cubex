// Shared by the tests of a lookup waiting for a column it reads to finish
// filling (lookup-fill-waits, lookup-fill-loops): the trash refill kit's
// sheets and lookups (3 rows each, Email u0..u2@a.com, Name N0..N2), a formula
// column on the other sheet whose next fill runs only when the test says so,
// and a lookup set to fill again as a restart or a restore finds it.
import assert from 'node:assert/strict'
import { refillKit } from './trash-refill-kit'
import formulaMod from '../../server/src/services/formula-column'
import formulaKindMod from '../../server/src/services/formula-kind'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import busyMod from '../../server/src/lib/sheet-busy'
import recMod from '../../server/src/lib/lookup-columns'
const { startFormulaColumn } = formulaMod as typeof import('../../server/src/services/formula-column')
const { formulaKind, FORMULA_FILLING } = formulaKindMod as typeof import('../../server/src/services/formula-kind')
const { runDerivedFill, waitForDerivedFill, resumeDerivedFills } =
  fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { loadLookupColumn } = recMod as typeof import('../../server/src/lib/lookup-columns')

export function lookupWaitKit(name: string) {
  const k = refillKit(name)
  const { db, uid, idle, rowsOf } = k
  const sheetName = (sid: string) => db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(sid) as string
  // A formula column F on sid, Name + suffix, filled.
  const formula = async (sid: string, suffix: string) => {
    const out = await startFormulaColumn(uid, sid, { column: 'F', formula: `{{Name}} + "${suffix}"` })
    assert.ok('ok' in out, JSON.stringify(out))
    await waitForDerivedFill(formulaKind, out.ok.id, 15_000)
    await idle(sid)
    return out.ok.id
  }
  // F set to fill again with another suffix (as a save of the column does), its fill not started:
  // fillF() runs it, as the sheet's heavy operation.
  const refillFormula = (fid: string, from: string, to: string) => {
    const f = db.prepare('SELECT formula FROM formula_columns WHERE id = ?').pluck().get(fid) as string
    db.prepare(`UPDATE formula_columns SET formula = ?, fill_status = 'filling', fill_cursor = 0, filled_rows = 0
      WHERE id = ?`).run(f.replace(from, to), fid)
  }
  const fillF = async (sid: string, fid: string) => {
    const out = await withSheetBusy(sid, FORMULA_FILLING, () => runDerivedFill(formulaKind, fid))
    assert.ok(!out || !('busy' in out), JSON.stringify(out))
  }
  // As a restart finds a lookup: filling, from `at` (a rowid: the rows before it written).
  const fillingFrom = (id: string, at = 0, written = 0) => {
    db.prepare(`UPDATE lookup_columns SET fill_status = 'filling', fill_cursor = ?, filled_rows = ?,
      error_message = NULL WHERE id = ?`).run(at, written, id)
  }
  const resumeLookups = () => resumeDerivedFills(lookupKind)
  const rec = (id: string) => loadLookupColumn(id)
  const rowids = (sid: string) => db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY rowid')
    .pluck().all(sid) as number[]
  const setCells = (sid: string, col: string, values: string[]) => {
    rowsOf(sid).forEach((r, i) => {
      if (i < values.length) db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE id = ?')
        .run(`$."${col}"`, values[i], r.id)
    })
  }
  return { ...k, sheetName, formula, refillFormula, fillF, fillingFrom, resumeLookups, rec, rowids, setCells }
}
