// Shared by the tests of a lookup waiting for a column it reads to finish
// filling (lookup-fill-waits, lookup-fill-loops, lookup-fill-changes,
// lookup-fill-lists): the trash refill kit's sheets and lookups (3 rows each,
// Email u0..u2@a.com, Name N0..N2), a formula column on the other sheet whose
// next fill runs only when the test says so, a lookup set to fill again as a
// restart or a restore finds it, runs held open or paused, a lookup's fill
// one row a slice, and a lookup record that only looks.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
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
  // An HTTP run writing `column` of sid, running until endRun (batch: one auto-run started for new rows).
  const httpRun = (sid: string, column: string, batch: boolean, status = 'running') => {
    const id = uuid()
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, status, master_column_name, autorun_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, sid, uid, status, column, batch ? uuid() : null)
    return id
  }
  const endRun = (id: string) => db.prepare(`UPDATE http_runs SET status = 'completed', updated_at = datetime('now')
    WHERE id = ?`).run(id)
  const runNote = (sid: string, column: string) =>
    `Waiting for a run to finish filling "${column}" in "${sheetName(sid)}".`
  // A paused run going on again, as a resume does (run-lifecycle.ts): pending, its worker_generation moved.
  const resumeRun = (id: string) => db.prepare(`UPDATE http_runs SET status = 'pending',
    worker_generation = worker_generation + 1 WHERE id = ? AND status = 'paused'`).run(id)
  // The lookup's fill one row a slice (as a big sheet's time budget cuts them); after(n) inside the
  // transaction that wrote a row, for the first `times` rows it writes (n: 1, 2…).
  const oneRowASlice = (id: string, after: (n: number) => void, times = 1) => {
    const open = lookupKind.open, advance = lookupKind.advance
    let fired = 0
    lookupKind.open = async (r, use) => {
      const pass = await open.call(lookupKind, r, use)
      if (r.id !== id || 'error' in pass) return pass
      return { ...pass, compute: (rows, budgetMs) => pass.compute(rows.slice(0, 1), budgetMs) }
    }
    lookupKind.advance = (r, cursor, counts) => {
      advance.call(lookupKind, r, cursor, counts)
      if (r.id === id && fired < times) after(++fired)
    }
    return { restore: () => { lookupKind.open = open; lookupKind.advance = advance } }
  }
  // A lookup's record filling on a sheet of its own (it fills nothing: tests ask readsChangedUnseen for
  // it), looking in otherSheetId.
  const probe = (otherSheetId: string) => {
    const id = uuid(), sid = k.place().sid
    db.prepare(`INSERT INTO lookup_columns (id, user_id, sheet_id, column_name, source_column, other_sheet_id,
      match_column, match_mode, returns, fill_status) VALUES (?, ?, ?, 'P', 'Email', ?, 'Email', 'equals', 'count',
      'filling')`).run(id, uid, sid, otherSheetId)
    return { id, user_id: uid, other_sheet_id: otherSheetId, fill_cursor: 0 }
  }
  return { ...k, sheetName, formula, refillFormula, fillF, fillingFrom, resumeLookups, rec, rowids, setCells,
    httpRun, endRun, resumeRun, runNote, oneRowASlice, probe }
}
