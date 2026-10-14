// Clean data columns against a migrated throwaway DB (services/clean-*.ts):
// a new column is listed, recorded and filled with counts; an empty result is
// an empty cell; a fill resumed from its cursor ends the same way; naming the
// clean column again changes it; auto-run follows the source (a written
// source cell, a new row) and leaves a hand edit alone until the source
// changes; refusals; rename and delete keep the record in step.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import colMod from '../../server/src/services/clean-column'
import fillMod from '../../server/src/services/clean-fill'
import followMod from '../../server/src/services/clean-follow'
import markMod from '../../server/src/lib/autorun-mark'
import recMod from '../../server/src/lib/clean-columns'
import entryMod from '../../server/src/services/autorun-entry'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { startCleanColumn } = colMod as typeof import('../../server/src/services/clean-column')
const { runCleanFill, waitForCleanFill } = fillMod as typeof import('../../server/src/services/clean-fill')
const { cleanFollowTick } = followMod as typeof import('../../server/src/services/clean-follow')
const { markAutorunEdits } = markMod as typeof import('../../server/src/lib/autorun-mark')
const {
  cleanColumnFor, cleanLoopThrough, cleanRenameLoop, renameCleanColumnRefs, deleteCleanColumnRefs,
  forgetUnlistedCleanColumns,
} = recMod as typeof import('../../server/src/lib/clean-columns')
const { entryFor } = entryMod as typeof import('../../server/src/services/autorun-entry')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sheetId, tableId, uid, 'S', JSON.stringify(['Name', 'Notes']))
const NAMES = ['  ADA   Lovelace ', 'Grace\u00a0Hopper', '', '   ', 'Alan Turing']
const rowIds = NAMES.map((n, i) => {
  const id = uuid()
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(id, sheetId, uid, i, JSON.stringify(n ? { Name: n } : {}))
  return id
})
const cells = (col: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(sheetId) as string[]).map(d => JSON.parse(d)[col])
const columns = () => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
  .get(sheetId) as string) as string[]
const edit = (row: number, column: string, value: string) => {
  db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE id = ?').run(`$."${column}"`, value, rowIds[row])
  markAutorunEdits(sheetId, uid, [{ column, rowId: rowIds[row] }])
}
const follow = async (column: string) => {
  const e = entryFor(sheetId, uid, column)!
  await cleanFollowTick(e)
}
// The fill runs once the busy window's work returns; give it a moment.
const settle = () => new Promise(r => setTimeout(r, 50))

async function main() {
  const started = await startCleanColumn(uid, sheetId, { source: 'Name', cleaner: 'trim' })
  check('a new clean column starts', 'ok' in started && started.ok.created && started.ok.column === 'Name (clean)',
    started)
  if (!('ok' in started)) return
  const rec = await waitForCleanFill(started.ok.id, 5_000)
  await settle()
  check('it is listed', columns().includes('Name (clean)'))
  check('the fill is done with its counts (spaces-only source counts as empty, not unreadable)',
    rec?.fill_status === 'done' && rec.filled_rows === 3 && rec.blanked_rows === 0, rec)
  check('values are cleaned; empty results are empty cells',
    JSON.stringify(cells('Name (clean)')) === JSON.stringify(['ADA Lovelace', 'Grace Hopper', undefined,
      undefined, 'Alan Turing']), cells('Name (clean)'))
  check('auto-run is on, of kind clean, reading the source',
    entryFor(sheetId, uid, 'Name (clean)')?.kind === 'clean'
    && entryFor(sheetId, uid, 'Name (clean)')?.input_columns === '["Name"]')

  // A restart part-way: the rows after the cursor are filled, the ones before kept.
  const rowids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY rowid').pluck().all(sheetId) as number[]
  db.prepare(`UPDATE rows SET data = json_remove(data, '$."Name (clean)"') WHERE sheet_id = ?`).run(sheetId)
  db.prepare(`UPDATE clean_columns SET fill_status = 'filling', fill_cursor = ?, filled_rows = 1 WHERE id = ?`)
    .run(rowids[1], started.ok.id)
  await runCleanFill(started.ok.id)
  check('a resumed fill goes on from its cursor',
    JSON.stringify(cells('Name (clean)')) === JSON.stringify([undefined, undefined, undefined, undefined,
      'Alan Turing']) && cleanColumnFor(sheetId, uid, 'Name (clean)')?.fill_status === 'done',
    cells('Name (clean)'))

  // Naming the clean column again changes it and cleans every row again.
  const changed = await startCleanColumn(uid, sheetId, { source: 'Name', cleaner: 'lowercase', column: 'Name (clean)' })
  check('naming the clean column again changes it', 'ok' in changed && !changed.ok.created, changed)
  if ('ok' in changed) await waitForCleanFill(changed.ok.id, 5_000)
  await settle()
  check('every row is cleaned with the new cleaner', cells('Name (clean)')[0] === 'ada lovelace', cells('Name (clean)'))

  // Auto-run follows the source...
  edit(1, 'Name', 'GRACE  B. HOPPER')
  await follow('Name (clean)')
  check('a written source cell is cleaned again', cells('Name (clean)')[1] === 'grace b. hopper', cells('Name (clean)'))
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(uuid(), sheetId, uid, 5, JSON.stringify({ Name: 'NEW  Row' }))
  await follow('Name (clean)')
  check('a new row is cleaned', cells('Name (clean)')[5] === 'new row', cells('Name (clean)'))
  // ...and leaves a hand edit alone until the source changes.
  edit(0, 'Name (clean)', 'Ada (hand fixed)')
  edit(2, 'Notes', 'unrelated')
  await follow('Name (clean)')
  check('a hand edit stays while its source is untouched', cells('Name (clean)')[0] === 'Ada (hand fixed)')
  edit(0, 'Name', 'Ada King')
  await follow('Name (clean)')
  check('it gives way once the source changes', cells('Name (clean)')[0] === 'ada king', cells('Name (clean)'))
  // A run's own words are not data: "⏭️ Not found" cleans to an empty cell.
  edit(4, 'Name', '\u23ed\ufe0f Not found')
  await follow('Name (clean)')
  check('a source holding a run marker reads as empty', cells('Name (clean)')[4] === undefined, cells('Name (clean)'))
  // A new row that arrives with its clean cell filled and no source keeps it.
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(uuid(), sheetId, uid, 6, JSON.stringify({ 'Name (clean)': 'kept as it came' }))
  await follow('Name (clean)')
  check('a new row with an empty source keeps its clean cell', cells('Name (clean)')[6] === 'kept as it came')

  // Refusals.
  const taken = await startCleanColumn(uid, sheetId, { source: 'Name', cleaner: 'trim', column: 'Notes' })
  check('an existing column that is not a clean column is refused', 'fail' in taken && taken.fail === 'conflict')
  const self = await startCleanColumn(uid, sheetId, { source: 'Name', cleaner: 'trim', column: 'Name' })
  check('the source itself is refused', 'fail' in self && self.fail === 'bad_request')
  const unknown = await startCleanColumn(uid, sheetId, { source: 'Name', cleaner: 'shout' })
  check('an unknown cleaner is refused', 'fail' in unknown && /Unknown cleaner/.test(unknown.message))
  const chained = await startCleanColumn(uid, sheetId, { source: 'Name (clean)', cleaner: 'trim', column: 'Y' })
  if ('ok' in chained) await waitForCleanFill(chained.ok.id, 5_000)
  await settle()
  check('a clean column of a clean column is fine', 'ok' in chained)
  check('a loop is found', cleanLoopThrough(sheetId, uid, 'Name (clean)', 'Y') !== null)
  const loop = await startCleanColumn(uid, sheetId, { source: 'Y', cleaner: 'trim', column: 'Name (clean)' })
  check('a loop is refused', 'fail' in loop && /can't be cleaned/.test(loop.message), loop)

  // A rename that would close a loop is found (X is gone; renaming Y to X would make it its own source).
  check('a rename that closes a loop is found', cleanRenameLoop(sheetId, uid, 'Name', 'Y') !== null
    && cleanRenameLoop(sheetId, uid, 'Name', 'Full name') === null)

  // Rename and delete keep the record in step.
  renameCleanColumnRefs(sheetId, uid, 'Name', 'Full name')
  renameCleanColumnRefs(sheetId, uid, 'Name (clean)', 'Clean')
  const renamed = cleanColumnFor(sheetId, uid, 'Clean')
  check('rename follows the column and its source', renamed?.source_column === 'Full name'
    && cleanColumnFor(sheetId, uid, 'Y')?.source_column === 'Clean')
  deleteCleanColumnRefs(sheetId, uid, 'Clean')
  check('delete forgets the record', cleanColumnFor(sheetId, uid, 'Clean') === undefined)
  // A CSV replace that leaves a clean column out forgets it and its auto-run.
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['Full name', 'Notes']), sheetId)
  forgetUnlistedCleanColumns(sheetId, uid)
  check('a replace without the column forgets its record and auto-run',
    cleanColumnFor(sheetId, uid, 'Y') === undefined && entryFor(sheetId, uid, 'Y') === undefined)
}

main().then(() => {
  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
  console.log('\nAll clean column assertions passed.')
  process.exit(0)
}, err => { console.error(err); process.exit(1) })
