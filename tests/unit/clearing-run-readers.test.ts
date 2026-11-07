// A run stopped or failed keeps its ⏳ cells until its clear reaches them
// (lib/placeholder-cells.ts), so what would read them treats it as a run that
// is still going: an AI run's prompt check (lib/prompt-ref-validate.ts, what a
// start and a preview ask) refuses a prompt reading its column, so the model is
// never sent (and billed for) "⏳ Processing...", and transform_column
// (services/column-transform.ts) refuses that column as its source, a column a
// template names, or its target, so it never copies a ⏳. A running run is
// named as before; a stopped one's words say its cells are getting back what
// they held. transfer_rows (services/rows-transfer.ts) refuses a copied source
// column a stopped run is still putting back, as it refuses a running run on
// either sheet, so it never copies a ⏳ into another sheet. Once the clear is
// done, all of them go through and read the answers put back.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import cellsMod from '../../server/src/lib/placeholder-cells'
import placeholdersMod from '../../server/src/lib/run-placeholders'
import promptMod from '../../server/src/lib/prompt-ref-validate'
import transformMod from '../../server/src/services/column-transform'
import transferMod from '../../server/src/services/rows-transfer'
const { seedProcessingPlaceholders, PLACEHOLDER } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { clearRunPlaceholders } = placeholdersMod as typeof import('../../server/src/lib/run-placeholders')
const { unknownPromptRefsError } = promptMod as typeof import('../../server/src/lib/prompt-ref-validate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { transferRows } = transferMod as typeof import('../../server/src/services/rows-transfer')
const { db, uid, ok, done, sheet, cells } = undoKit('clearing-run-readers')
console.error = () => {}

// Earlier answers in Answer; a rerun of it running, its ⏳ in every row (what Answer held kept first).
async function scene() {
  const sid = sheet([{ Name: 'ada', Answer: 'Old A' }, { Name: 'bob', Answer: 'Old B' }], ['Name', 'Answer'])
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Answer')`).run(run, sid, uid)
  await seedProcessingPlaceholders({ run: { kind: 'http', id: run }, sheetId: sid, userId: uid, columns: ['Answer'],
    targets: null, lastRow: 1, live: () => true })
  assert.deepEqual(cells(sid, 'Answer'), [PLACEHOLDER, PLACEHOLDER])
  // As a cancel or a worker's failure leaves it while its clear goes on.
  const stop = () => db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing'
    WHERE id = ?`).run(run)
  return { sid, run, stop }
}

const PROMPT = 'Write one line about /Answer for /Name.'
const READS = '/Answer reads "Answer", which a run that hasn\'t finished is still filling. '
  + 'Wait for that run to finish (or stop it), then try again.'
const READS_BACK = '/Answer reads "Answer", which is getting back what it held before a stopped run. '
  + 'Try again in a moment.'

await ok('an AI run\'s prompt reading a column a stopped run is still putting back: refused as for a running run',
  async () => {
    const { sid, run, stop } = await scene()
    assert.equal(unknownPromptRefsError(sid, uid, PROMPT), READS, 'a running run')
    stop()
    assert.equal(unknownPromptRefsError(sid, uid, PROMPT), READS_BACK, 'a stopped run still clearing')
    await clearRunPlaceholders('http', run)
    assert.deepEqual(cells(sid, 'Answer'), ['Old A', 'Old B'])
    assert.equal(unknownPromptRefsError(sid, uid, PROMPT), null)
  })

const GOING = (c: string) => `Column "${c}" is being written by a run that hasn't finished. `
  + 'Wait for it to finish (or stop it) first.'
const BACK = (c: string) => `Column "${c}" is getting back what it held before a stopped run. Try again in a moment.`
const STATES = ['a running run', 'a stopped run still clearing']

await ok('transform_column from or into a column a stopped run is still putting back: refused as for a running run',
  async () => {
    const { sid, run, stop } = await scene()
    const from = () => transformColumn(uid, { sheetId: sid, operation: 'upper', sourceColumn: 'Answer',
      targetColumn: 'Loud' })
    const into = () => transformColumn(uid, { sheetId: sid, operation: 'upper', sourceColumn: 'Name',
      targetColumn: 'Answer' })
    const words: string[] = []
    for (const state of STATES) {
      if (state !== STATES[0]) stop()
      for (const out of [from(), into()]) {
        assert.equal('fail' in out && out.fail, 'locked', `${state}: ${JSON.stringify(out)}`)
        words.push((out as { error: string }).error)
      }
    }
    assert.deepEqual(cells(sid, 'Loud'), ['', ''], 'nothing copied')
    assert.deepEqual(words, [GOING('Answer'), GOING('Answer'), BACK('Answer'), BACK('Answer')])
    await clearRunPlaceholders('http', run)
    assert.deepEqual(from(), { ok: { updated: 2, created_column: 'Loud' } })
    assert.deepEqual(cells(sid, 'Loud'), ['OLD A', 'OLD B'])
  })

await ok('a template transform naming a column a run holds, going or putting its cells back: refused, nothing '
  + 'written; after the clear it copies the answers put back', async () => {
  const { sid, run, stop } = await scene()
  // The name as the template's own substitution reads it, spaces trimmed.
  const copy = () => transformColumn(uid, { sheetId: sid, operation: 'template',
    template: 'Was: {{ Answer }} ({{Name}})', targetColumn: 'Copy' })
  const words: string[] = []
  for (const state of STATES) {
    if (state !== STATES[0]) stop()
    const out = copy()
    assert.equal('fail' in out && out.fail, 'locked', `${state}: ${JSON.stringify(out)}`)
    words.push((out as { error: string }).error)
    assert.deepEqual(cells(sid, 'Copy'), ['', ''], `${state}: nothing written`)
  }
  assert.deepEqual(words, [GOING('Answer'), BACK('Answer')])
  await clearRunPlaceholders('http', run)
  assert.deepEqual(copy(), { ok: { updated: 2, created_column: 'Copy' } })
  assert.deepEqual(cells(sid, 'Copy'), ['Was: Old A (ada)', 'Was: Old B (bob)'])
})

await ok('transfer_rows copying a column a run holds, going or putting its cells back: refused, nothing copied; '
  + 'a transfer leaving that column out goes through; after the clear it copies the answers put back', async () => {
  const { sid, run, stop } = await scene()
  const dest = sheet([], []), other = sheet([], [])
  let key = 0
  const copy = (to: string, columns?: string[]) => transferRows(uid, { sourceSheetId: sid, destinationSheetId: to,
    operation: 'copy', selection: { all: true }, columns, columnMode: 'create_missing', columnModeOmitted: false,
    columnMapping: {}, idempotencyKey: `held-${++key}` })
  const rowsIn = (s: string) => db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(s)
  // A running run on either sheet is refused sheet-wide, before any column is looked at.
  const SHEET_WIDE = 'Cannot transfer rows while either sheet has an active run.'
  assert.deepEqual(copy(dest), { fail: 'active_run', error: SHEET_WIDE })
  stop()
  assert.deepEqual(copy(dest), { fail: 'active_run', error: BACK('Answer') })
  assert.deepEqual(copy(dest, ['Answer']), { fail: 'active_run', error: BACK('Answer') })
  assert.equal(rowsIn(dest), 0, 'nothing copied')
  const nameOnly = copy(other, ['Name'])
  assert.ok('ok' in nameOnly && nameOnly.ok.copied === 2, JSON.stringify(nameOnly))
  assert.deepEqual(cells(other, 'Name'), ['ada', 'bob'])
  await clearRunPlaceholders('http', run)
  const out = copy(dest)
  assert.ok('ok' in out && out.ok.copied === 2, JSON.stringify(out))
  assert.deepEqual(cells(dest, 'Answer'), ['Old A', 'Old B'])
  assert.deepEqual(cells(dest, 'Name'), ['ada', 'bob'])
})

done()
