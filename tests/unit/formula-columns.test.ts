// Formula columns against a migrated throwaway DB (services/formula-*.ts on the
// derived engine, services/derived-*.ts): a new column is listed, recorded with
// its formula written exactly and filled with counts; a row the formula can't
// work out shows its error; auto-run follows every input (and a chain of
// derived columns); a loop across clean and formula columns is refused; rename
// and delete keep the record in step; a formula too slow fails its fill, or
// pauses its auto-run; a fill resumes from its cursor; preview reads only.
// Over 200 lines: one scenario on one sheet, each step building on the last.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import colMod from '../../server/src/services/formula-column'
import previewMod from '../../server/src/services/formula-preview'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/formula-kind'
import followMod from '../../server/src/services/derived-follow'
import cleanMod from '../../server/src/services/clean-column'
import markMod from '../../server/src/lib/autorun-mark'
import recMod from '../../server/src/lib/formula-columns'
import renameMod from '../../server/src/services/formula-rename'
import loopMod from '../../server/src/lib/derived-loops'
import entryMod from '../../server/src/services/autorun-entry'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { startFormulaColumn, setFormulaColumnAutorun } =
  colMod as typeof import('../../server/src/services/formula-column')
const { previewFormulaColumn } = previewMod as typeof import('../../server/src/services/formula-preview')
const { runDerivedFill, waitForDerivedFill } = fillMod as typeof import('../../server/src/services/derived-fill')
const { formulaKind } = kindMod as typeof import('../../server/src/services/formula-kind')
const { derivedFollowTick } = followMod as typeof import('../../server/src/services/derived-follow')
const { startCleanColumn } = cleanMod as typeof import('../../server/src/services/clean-column')
const { markAutorunEdits } = markMod as typeof import('../../server/src/lib/autorun-mark')
const {
  formulaColumnFor, renameFormulaColumnRefs, deleteFormulaColumnRefs, forgetUnlistedFormulaColumns,
} = recMod as typeof import('../../server/src/lib/formula-columns')
const { formulaRenameProblem } = renameMod as typeof import('../../server/src/services/formula-rename')
const { derivedRenameLoop } = loopMod as typeof import('../../server/src/lib/derived-loops')
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
  .run(sheetId, tableId, uid, 'S', JSON.stringify(['Response', 'Name', 'Score']))
const reply = (work: string | null) => JSON.stringify({
  emails: [{ type: 'personal', value: 'me@gmail.com' }, ...(work ? [{ type: 'work', value: work }] : [])],
})
const ROWS = [
  { Response: reply('ada@acme.com'), Name: 'Ada', Score: '7' },
  { Response: reply(null), Name: 'Grace', Score: '9' },
  { Name: 'Alan' },
  { Response: '⏳ Processing...', Name: 'Edsger', Score: '3' },
]
const rowIds = ROWS.map((data, i) => {
  const id = uuid()
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(id, sheetId, uid, i, JSON.stringify(data))
  return id
})
const addRow = (data: Record<string, string>) => {
  const i = db.prepare('SELECT MAX(row_index) + 1 FROM rows WHERE sheet_id = ?').pluck().get(sheetId) as number
  const id = uuid()
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(id, sheetId, uid, i, JSON.stringify(data))
  rowIds.push(id)
}
const cells = (col: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(sheetId) as string[]).map(d => JSON.parse(d)[col])
const columns = () => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
  .get(sheetId) as string) as string[]
const edit = (row: number, column: string, value: string) => {
  db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE id = ?').run(`$."${column}"`, value, rowIds[row])
  markAutorunEdits(sheetId, uid, [{ column, rowId: rowIds[row] }])
}
const follow = async (column: string) => { await derivedFollowTick(entryFor(sheetId, uid, column)!) }
const settle = () => new Promise(r => setTimeout(r, 50))
async function create(column: string, formula: string, extra: Record<string, unknown> = {}) {
  const out = await startFormulaColumn(uid, sheetId, { column, formula, ...extra })
  if ('ok' in out) await waitForDerivedFill(formulaKind, out.ok.id, 30_000)
  await settle()
  return out
}

async function main() {
  const WORK = '{{response}}?.emails?.find(e => e.type == "work")?.value'
  const started = await create('Work email', WORK)
  check('a new formula column starts', 'ok' in started && started.ok.created, started)
  const rec = formulaColumnFor(sheetId, uid, 'Work email')
  check('it is listed', columns().includes('Work email'))
  check('the formula is kept with the exact name, and what it reads',
    rec?.formula === WORK.replace('{{response}}', '{{Response}}') && rec?.inputs === '["Response"]', rec)
  check('the fill is done with its counts',
    rec?.fill_status === 'done' && rec.filled_rows === 1 && rec.error_rows === 0, rec)
  check('values worked out; no match and markers read empty',
    JSON.stringify(cells('Work email')) === JSON.stringify(['ada@acme.com', undefined, undefined, undefined]),
    cells('Work email'))
  check('auto-run is on, of kind formula, reading the inputs',
    entryFor(sheetId, uid, 'Work email')?.kind === 'formula'
    && entryFor(sheetId, uid, 'Work email')?.input_columns === '["Response"]')

  const broken = await create('Broken', '{{Response}}.emails.find(e => e.type == "work").value')
  const b = formulaColumnFor(sheetId, uid, 'Broken')
  check('a row the formula can\'t work out shows its error; the fill still ends done',
    'ok' in broken && b?.fill_status === 'done' && b.error_rows === 3 && /^Row 2: TypeError/.test(b.first_error ?? '')
    && /^❌ TypeError/.test(cells('Broken')[1]), { b, cells: cells('Broken') })

  // Several inputs: either one written works the row out again.
  await create('Label', '`${{{Name}}} (${Number({{Score}}) * 10})`')
  check('a template with two inputs', cells('Label')[0] === 'Ada (70)', cells('Label'))
  edit(0, 'Score', '8')
  await follow('Label')
  check('a written input is followed', cells('Label')[0] === 'Ada (80)', cells('Label'))
  edit(0, 'Name', 'Ada L')
  await follow('Label')
  check('so is the other input', cells('Label')[0] === 'Ada L (80)', cells('Label'))
  addRow({ Name: 'Barbara', Score: '5' })
  await follow('Label')
  check('a new row is worked out', cells('Label')[4] === 'Barbara (50)', cells('Label'))
  edit(1, 'Label', 'hand fixed')
  edit(2, 'Response', reply('x@y.z'))
  await follow('Label')
  check('a hand edit stays while its inputs are untouched', cells('Label')[1] === 'hand fixed')

  // A chain: a formula reading a formula follows it.
  await create('Domain', '{{Work email}}?.split("@")[1]')
  edit(1, 'Response', reply('grace@navy.mil'))
  await follow('Work email')
  await follow('Domain')
  check('a chain of formulas follows', cells('Work email')[1] === 'grace@navy.mil' && cells('Domain')[1] === 'navy.mil',
    { w: cells('Work email'), d: cells('Domain') })

  // Refusals.
  const clean = await startCleanColumn(uid, sheetId, { source: 'Domain', cleaner: 'lowercase', column: 'Domain clean' })
  await settle()
  check('a clean column of a formula column is fine', 'ok' in clean, clean)
  const loop = await startFormulaColumn(uid, sheetId, { column: 'Work email', formula: '{{Domain clean}}' })
  check('a loop through a clean column is refused', 'fail' in loop && /worked out from "Work email"/.test(loop.message),
    loop)
  const self = await startFormulaColumn(uid, sheetId, { column: 'Domain', formula: '{{Domain}} + 1' })
  check('a formula reading its own column is refused', 'fail' in self && /its own column/.test(self.message), self)
  const syntax = await startFormulaColumn(uid, sheetId, { column: 'Z', formula: '{{Name}} +* 2' })
  check('a syntax error is refused before saving', 'fail' in syntax && /SyntaxError/.test(syntax.message)
    && !columns().includes('Z'), syntax)
  const typo = await startFormulaColumn(uid, sheetId, { column: 'Z', formula: '{{Nmae}}' })
  check('a misspelled column is refused with a suggestion', 'fail' in typo && /Did you mean "Name"/.test(typo.message))
  const taken = await startFormulaColumn(uid, sheetId, { column: 'Score', formula: '1' })
  check('an existing column that is not a formula column is refused', 'fail' in taken && taken.fail === 'conflict')
  const noName = await startFormulaColumn(uid, sheetId, { formula: '1' })
  check('a formula column needs a name', 'fail' in noName && noName.fail === 'bad_request')

  // Rename and delete keep the records in step.
  check('a rename that closes a loop is found', derivedRenameLoop(sheetId, uid, 'Response', 'Domain clean') !== null
    && derivedRenameLoop(sheetId, uid, 'Response', 'API reply') === null)
  check('a name a formula can\'t write is refused', await formulaRenameProblem(sheetId, uid, 'Name', 'Size}') !== null
    && await formulaRenameProblem(sheetId, uid, 'Name', 'Full name') === null)
  await create('Greeting', "'Hi {{Name}}, {{nobody}}'")
  check('text naming no column is kept escaped', formulaColumnFor(sheetId, uid, 'Greeting')?.formula
    === "'Hi {{Name}}, {\\{nobody}}'" && cells('Greeting')[0] === 'Hi Ada L, {{nobody}}', cells('Greeting'))
  const quote = await formulaRenameProblem(sheetId, uid, 'Name', "Owner's name")
  check('a rename that would break a formula\'s string is refused, naming it', /"Greeting"/.test(quote ?? ''), quote)
  deleteFormulaColumnRefs(sheetId, uid, 'Greeting')
  renameFormulaColumnRefs(sheetId, uid, 'Response', 'API reply')
  const renamed = formulaColumnFor(sheetId, uid, 'Work email')
  check('renaming an input rewrites the formula and its inputs', renamed?.formula.startsWith('{{API reply}}?.emails')
    && renamed.inputs === '["API reply"]', renamed)
  renameFormulaColumnRefs(sheetId, uid, 'API reply', 'Response')
  renameFormulaColumnRefs(sheetId, uid, 'Broken', 'Broken 2')
  check('renaming the formula column moves its record', !!formulaColumnFor(sheetId, uid, 'Broken 2'))
  deleteFormulaColumnRefs(sheetId, uid, 'Broken 2')
  check('delete forgets the record', !formulaColumnFor(sheetId, uid, 'Broken 2'))

  // A resumed fill goes on from its cursor.
  const rowids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY rowid').pluck().all(sheetId) as number[]
  db.prepare(`UPDATE rows SET data = json_remove(data, '$."Label"') WHERE sheet_id = ?`).run(sheetId)
  const label = formulaColumnFor(sheetId, uid, 'Label')!
  db.prepare(`UPDATE formula_columns SET fill_status = 'filling', fill_cursor = ? WHERE id = ?`)
    .run(rowids[1], label.id)
  await runDerivedFill(formulaKind, label.id)
  check('a resumed fill goes on from its cursor', cells('Label')[0] === undefined && cells('Label')[2] === 'Alan (0)'
    && formulaColumnFor(sheetId, uid, 'Label')?.fill_status === 'done', cells('Label'))

  // Too slow: a fill stops after a few rows out of time; auto-run pauses.
  const t0 = Date.now()
  const slow = await create('Slow', '(() => { while (true) {} })() + {{Name}}')
  const s = formulaColumnFor(sheetId, uid, 'Slow')
  check('a formula too slow fails its fill, quickly', 'ok' in slow && s?.fill_status === 'failed'
    && /out of time or memory on 3 rows/.test(s.error_message ?? '') && Date.now() - t0 < 3000, s)
  await create('Picky', '{{Name}} == "slow" ? (() => { while (true) {} })() : {{Name}}')
  for (let k = 0; k < 3; k++) addRow({ Name: 'slow' })
  await follow('Picky')
  const picky = entryFor(sheetId, uid, 'Picky')
  check('a follow too slow pauses auto-run', picky?.paused_reason === 'too_slow', picky)
  await create('Picky', '{{Name}}')
  check('saving the formula again lifts that pause', entryFor(sheetId, uid, 'Picky')?.paused_reason === null)

  // Auto-run off, then on again: every row is worked out again.
  const work = formulaColumnFor(sheetId, uid, 'Work email')!
  await setFormulaColumnAutorun(uid, sheetId, work, false)
  check('auto-run off', entryFor(sheetId, uid, 'Work email')?.enabled === 0)
  edit(0, 'Response', reply('new@acme.com'))
  await setFormulaColumnAutorun(uid, sheetId, work, true)
  await waitForDerivedFill(formulaKind, work.id, 30_000)
  await settle()
  check('auto-run on again refills', cells('Work email')[0] === 'new@acme.com'
    && entryFor(sheetId, uid, 'Work email')?.enabled === 1, cells('Work email'))

  // Preview reads only.
  const before = JSON.stringify(cells('Work email'))
  const p = await previewFormulaColumn(uid, sheetId, { formula: '{{response}}?.emails?.length' })
  check('preview: samples with inputs and results, nothing written', 'ok' in p && p.ok.samples[0].result === '2'
    && p.ok.formula === '{{Response}}?.emails?.length' && JSON.stringify(cells('Work email')) === before
    && !columns().includes('null'), p)
  const pBad = await previewFormulaColumn(uid, sheetId, { formula: '{{Name}} +* 2' })
  check('preview: a syntax error is a bad request', 'fail' in pBad && /SyntaxError/.test(pBad.message))

  // A CSV replace without a formula column forgets it.
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?')
    .run(JSON.stringify(columns().filter(c => c !== 'Domain')), sheetId)
  forgetUnlistedFormulaColumns(sheetId, uid)
  check('a replace without the column forgets its record and auto-run',
    !formulaColumnFor(sheetId, uid, 'Domain') && !entryFor(sheetId, uid, 'Domain'))

  // Big JSON cells: a slice reads only what it can work out, so the fill stays quick.
  const big = JSON.stringify({ emails: [{ type: 'work', value: 'big@x.com' }], pad: 'p'.repeat(60_000) })
  db.transaction(() => { for (let k = 0; k < 600; k++) addRow({ Response: big, Name: `b${k}` }) })()
  const tBig = Date.now()
  await create('Big work email', '{{Response}}?.emails?.[0]?.value')
  check(`600 rows of 60 KB JSON filled in ${Date.now() - tBig} ms`, formulaColumnFor(sheetId, uid, 'Big work email')
    ?.fill_status === 'done' && cells('Big work email').filter(v => v === 'big@x.com').length === 600
    && Date.now() - tBig < 10_000)

  // Many rows: time-bounded slices still reach every row.
  const many = db.transaction(() => { for (let k = 0; k < 12_000; k++) addRow({ Name: `n${k}`, Score: String(k) }) })
  many()
  const t1 = Date.now()
  await create('Double', 'Number({{Score}}) * 2')
  const d = formulaColumnFor(sheetId, uid, 'Double')
  check(`12,000 more rows filled in ${Date.now() - t1} ms`, d?.fill_status === 'done'
    && cells('Double').at(-1) === String(11_999 * 2), d)
}

main().then(() => {
  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nAll formula column assertions passed.')
  process.exit(0)
}).catch(e => { console.error(e); process.exit(1) })
