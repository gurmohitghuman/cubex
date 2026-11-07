// Over 200 lines: one fixture, each case a rule of what a run that ends early puts back, through the real code.
// A run that ends before reaching a row puts that row's earlier answer back
// (lib/placeholder-cells.ts, lib/run-undo/clear-back.ts): its ⏳ clear gives
// each cell still holding ⏳ the value the run's undo journal kept for it from
// before the run, with its JSON type. Rows the run answered keep their new
// values, a cell edited during the run is left alone, and a cell becomes '',
// as before, where nothing goes back: it was empty, the row had no key, it
// held a ⏳, the row came after the seeding or took a deleted row's rowid, the
// run kept no journal, or the column has no slot in it. A formula reading the
// column follows, queued quiet. An undo of the run afterwards takes back the
// rows it answered and finds the others already holding their old values.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import lifecycleMod from '../../server/src/services/run-lifecycle'
import seedRunMod from '../../server/src/services/run-seed'
import busyMod from '../../server/src/lib/sheet-busy'
import cellsMod from '../../server/src/lib/placeholder-cells'
import writeMod from '../../server/src/lib/run-cells-write'
import formulaMod from '../../server/src/services/formula-column'
import formulaKindMod from '../../server/src/services/formula-kind'
import fillMod from '../../server/src/services/derived-fill'
import followMod from '../../server/src/services/derived-follow'
import entryMod from '../../server/src/services/autorun-entry'
import undoMod from '../../server/src/services/run-undo'
import printMod from '../../server/src/lib/run-undo/print'
const { cancelRun } = lifecycleMod as typeof import('../../server/src/services/run-lifecycle')
const { seedThenEnqueue } = seedRunMod as typeof import('../../server/src/services/run-seed')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { seedProcessingPlaceholders, clearProcessingPlaceholders, PLACEHOLDER } =
  cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { writeRunCells } = writeMod as typeof import('../../server/src/lib/run-cells-write')
const { startFormulaColumn } = formulaMod as typeof import('../../server/src/services/formula-column')
const { formulaKind } = formulaKindMod as typeof import('../../server/src/services/formula-kind')
const { waitForDerivedFill } = fillMod as typeof import('../../server/src/services/derived-fill')
const { derivedFollowTick } = followMod as typeof import('../../server/src/services/derived-follow')
const { entryFor } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { undoRun } = undoMod as typeof import('../../server/src/services/run-undo')
const { oldValueOf, isEmptyCell, isListWords } = printMod as typeof import('../../server/src/lib/run-undo/print')
const { db, uid, ok, done, idle, sheet, edit, journal } = undoKit('run-end-keeps-answers')
console.error = () => {}

type Kind = 'ai' | 'http'
const TABLE = { ai: 'ai_runs', http: 'http_runs' } as const
const NO_KEY = '(no key)'
const until = async (what: string, cond: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !cond();) {
    if (Date.now() > end) throw new Error(`Timed out waiting until ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}
// Each row's value in `column` as the row holds it (its JSON type), or NO_KEY.
const values = (sid: string, column: string) =>
  (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sid) as string[])
    .map(d => { const o = JSON.parse(d); return column in o ? o[column] : NO_KEY })
const runOf = (kind: Kind, id: string) => db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id) as any

// A run as a worker has it: an AI run on `columns[0]` (the rest its typed output columns), or an HTTP run whose
// status column is `columns[0]` and whose extracted columns are the rest.
function insertRun(kind: Kind, sid: string, columns: string[], status = 'running', work: string | null = null) {
  const id = uuid()
  const [main, ...more] = columns
  if (kind === 'ai') {
    const outputs = more.length ? JSON.stringify(more.map(columnName => ({ columnName, type: 'text' }))) : null
    db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status,worker_generation,
      placeholder_work,output_columns) VALUES (?,?,?,?,'p',?,1,?,?)`).run(id, sid, uid, main, status, work, outputs)
  } else {
    db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,worker_generation,
      placeholder_work) VALUES (?,?,?,'{}',?,?,1,?)`).run(id, sid, uid, status, main, work)
    for (const c of more) {
      db.prepare(`INSERT INTO http_column_associations (id,sheet_id,user_id,master_column_name,extracted_column_name,
        run_id) VALUES (?,?,?,?,?,?)`).run(uuid(), sid, uid, main, c, id)
    }
  }
  return id
}
// The run's ⏳ seeded on every row (or `targets`), what the cells held kept in its journal first.
const seed = (kind: Kind, id: string, sid: string, columns: string[]) => seedProcessingPlaceholders({
  run: { kind, id }, sheetId: sid, userId: uid, columns, targets: null,
  lastRow: db.prepare('SELECT MAX(row_index) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number,
  live: () => true,
})
const answer = (kind: Kind, id: string, sid: string, row: number, cells: Array<[string, unknown]>) =>
  db.transaction(() => writeRunCells({ kind, id }, sid, uid, row, cells as Array<[string, string]>))()
// Cancelled through the code that cancels it; its clear runs in the background.
const cancel = async (kind: Kind, id: string) => {
  assert.deepEqual(await cancelRun(kind, id, uid), { ok: true })
  await until('the cancel cleared its cells', () => runOf(kind, id).placeholder_work === null)
}

await ok('a rerun cancelled before any row ran: every earlier answer is back with its type; a formula follows',
  async () => {
    const object = { k: 'v', n: [1, 2] }
    const sid = sheet([{ N: 'a', Answer: 'Old A' }, { N: 'b', Answer: 42 }, { N: 'c', Answer: object }],
      ['N', 'Answer'])
    const formula = { column: 'F', formula: '{{Answer}} ? "has " + JSON.stringify({{Answer}}) : "empty"' }
    const worked = ['has "Old A"', 'has "42"', 'has {"k":"v","n":[1,2]}']
    const fill = async () => {
      const f = await startFormulaColumn(uid, sid, formula)
      assert.ok('ok' in f, JSON.stringify(f))
      await waitForDerivedFill(formulaKind, f.ok.id, 30_000)
      await idle(sid)
    }
    await fill()
    assert.deepEqual(values(sid, 'F'), worked)
    const hook = uuid()
    db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns)
      VALUES (?,?,?,'Hook','http','["Answer"]')`).run(hook, uid, sid)
    const id = insertRun('ai', sid, ['Answer'])
    await seed('ai', id, sid, ['Answer'])
    assert.deepEqual(values(sid, 'Answer'), [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER])
    // Saved again while the run goes, the formula reads the ⏳ as empty.
    await fill()
    assert.deepEqual(values(sid, 'F'), ['empty', 'empty', 'empty'])
    db.prepare('DELETE FROM autorun_pending').run()
    await cancel('ai', id)
    assert.deepEqual(values(sid, 'Answer'), ['Old A', 42, object])
    const entry = entryFor(sid, uid, 'F')!
    const queued = db.prepare('SELECT quiet, COUNT(*) AS n FROM autorun_pending WHERE autorun_id = ? GROUP BY quiet')
      .all(entry.id)
    assert.deepEqual(queued, [{ quiet: 1, n: 3 }], 'every row queued for the formula, quiet')
    assert.equal(db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE autorun_id = ?').pluck().get(hook), 0,
      'nothing queued for an auto-run that sends requests')
    await derivedFollowTick(entry)
    assert.deepEqual(values(sid, 'F'), worked)
  })

for (const kind of ['ai', 'http'] as const) {
  await ok(`${kind}: cancelled part-way, answered rows keep their new values, the others get their old ones`,
    async () => {
      const sid = sheet([0, 1, 2, 3].map(i => ({ Answer: `Old ${i}` })), ['Answer'])
      const id = insertRun(kind, sid, ['Answer'])
      await seed(kind, id, sid, ['Answer'])
      answer(kind, id, sid, 0, [['Answer', 'New 0']])
      answer(kind, id, sid, 2, [['Answer', '❌ Error: boom']])
      await cancel(kind, id)
      assert.deepEqual(values(sid, 'Answer'), ['New 0', 'Old 1', '❌ Error: boom', 'Old 3'])
    })
}

await ok('nothing to put back: an empty cell, no key, a kept ⏳, a row after the seeding: all \'\'', async () => {
  const sid = sheet([{ Answer: '' }, { N: 'no key' }, { Answer: PLACEHOLDER }, { Answer: null }, { Answer: 'Old' }],
    ['N', 'Answer'])
  const id = insertRun('http', sid, ['Answer'])
  await seed('http', id, sid, ['Answer'])
  // A row that came after the seeding, holding ⏳ (as a webhook could deliver it): no record of it.
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,5,?)')
    .run(uuid(), sid, uid, JSON.stringify({ Answer: PLACEHOLDER }))
  await cancel('http', id)
  assert.deepEqual(values(sid, 'Answer'), ['', '', '', '', 'Old', ''])
})

await ok('what goes back is what print.ts would put back: never empty, a ⏳ or a list job\'s words', async () => {
  const kept: unknown[] = ['text', ' ', '0', 'null', '[]', 0, 1.5, -3, false, true, [], [1, 'a'], {}, { a: null },
    '', null, PLACEHOLDER, ` ${PLACEHOLDER}`, '⏳ other', '➕ Adding 3 rows…', '\u00a0\t➕ 2 results, waiting for fields',
    'a ➕ b', '❌ Error: x', '⏭️ Condition not met', '✅ 3 rows added']
  const sid = sheet(kept.map(Answer => ({ Answer })), ['Answer'])
  const id = insertRun('http', sid, ['Answer'])
  await seed('http', id, sid, ['Answer'])
  await cancel('http', id)
  const want = kept.map(v => {
    const old = oldValueOf([0, v, 0])
    return isEmptyCell(old) || isListWords(old) ? '' : v
  })
  assert.deepEqual(values(sid, 'Answer'), want)
  assert.equal(want.filter(v => v === '').length, 5, 'empty, null, ⏳ and two list jobs\' words')
})

await ok('a rowid a newer row took, a cell edited during the run, a clear without its run', async () => {
  const sid = sheet([{ Answer: 'Old 0' }, { Answer: 'Old 1' }, { Answer: 'Old 2' }], ['Answer'])
  const id = insertRun('ai', sid, ['Answer'])
  await seed('ai', id, sid, ['Answer'])
  edit(sid, 1, 'Answer', 'typed')
  // Row 2 deleted; a newer row takes its rowid, holding ⏳: the journal's record was the old row's.
  const rid = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? AND row_index = 2').pluck().get(sid) as number
  db.prepare('DELETE FROM rows WHERE rowid = ?').run(rid)
  db.prepare('INSERT INTO rows (rowid,id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,2,?)')
    .run(rid, uuid(), sid, uid, JSON.stringify({ Answer: PLACEHOLDER }))
  await cancel('ai', id)
  assert.deepEqual(values(sid, 'Answer'), ['Old 0', 'typed', ''])
  // Without the run (no caller passes one but a run's end), a ⏳ becomes '' though a journal kept its value.
  const other = sheet([{ Answer: 'Old' }], ['Answer'])
  const run2 = insertRun('ai', other, ['Answer'])
  await seed('ai', run2, other, ['Answer'])
  await clearProcessingPlaceholders(other, uid, ['Answer'])
  assert.deepEqual(values(other, 'Answer'), [''])
})

await ok('a run that kept no journal (begun before runs could be undone): \'\', as before', async () => {
  const sid = sheet([{ Answer: 'Old 0' }, { Answer: 'Old 1' }], ['Answer'])
  const id = insertRun('http', sid, ['Answer'])
  db.prepare("UPDATE http_runs SET created_at = '2000-01-01 00:00:00' WHERE id = ?").run(id)
  await seed('http', id, sid, ['Answer'])
  assert.equal(journal('http', id), undefined)
  await cancel('http', id)
  assert.deepEqual(values(sid, 'Answer'), ['', ''])
})

for (const kind of ['ai', 'http'] as const) {
  await ok(`${kind}: a rerun of rows 1 and 2 that failed to start after seeding: their old answers back`,
    async () => {
      const sid = sheet([{ Answer: 'Old 0' }, { Answer: 'Old 1' }, { Answer: 7 }], ['Answer'])
      const id = insertRun(kind, sid, ['Answer'], 'pending', 'seeding')
      await withSheetBusy(sid, 'starting a run', async () => {
        seedThenEnqueue({ kind, runId: id, sheetId: sid, userId: uid, columns: ['Answer'], targets: [1, 2],
          lastRow: 2, enqueue: async () => { throw new Error('the queue is down') } })
      })
      await until('the start failed and cleared its cells', () => runOf(kind, id).status === 'failed'
        && runOf(kind, id).placeholder_work === null)
      assert.equal(journal(kind, id)!.row_count, 2)
      assert.deepEqual(values(sid, 'Answer'), ['Old 0', 'Old 1', 7])
    })
}

await ok('several columns: a structured AI run and an HTTP run, each column its own old value', async () => {
  const sid = sheet([
    { Status: '✅ Done', Email: 'a@x.io', Phone: 5551 },
    { Status: '✅ Done', Email: 'b@x.io', Phone: 5552 },
    { Status: '❌ Error: old', Email: '', Phone: { ext: 9 } },
  ], ['Status', 'Email', 'Phone'])
  const id = insertRun('ai', sid, ['Status', 'Email', 'Phone'])
  await seed('ai', id, sid, ['Status', 'Email', 'Phone'])
  answer('ai', id, sid, 0, [['Status', '✅ Done'], ['Email', 'new@x.io'], ['Phone', '5559']])
  await cancel('ai', id)
  assert.deepEqual(values(sid, 'Status'), ['✅ Done', '✅ Done', '❌ Error: old'])
  assert.deepEqual(values(sid, 'Email'), ['new@x.io', 'b@x.io', ''])
  assert.deepEqual(values(sid, 'Phone'), ['5559', 5552, { ext: 9 }])

  // An HTTP run whose Body column holds ⏳ its journal has no slot for: that one is ''.
  const h = sheet([{ Call: '✅ 200', Code: 200, Body: 'old body' }, { Call: '✅ 201', Code: 201, Body: 'old 2' }],
    ['Call', 'Code', 'Body'])
  const hid = insertRun('http', h, ['Call', 'Code', 'Body'])
  await seed('http', hid, h, ['Call', 'Code'])
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Body', ?) WHERE sheet_id = ?`).run(PLACEHOLDER, h)
  assert.deepEqual(JSON.parse(journal('http', hid)!.columns), ['Call', 'Code'])
  await cancel('http', hid)
  assert.deepEqual(values(h, 'Call'), ['✅ 200', '✅ 201'])
  assert.deepEqual(values(h, 'Code'), [200, 201])
  assert.deepEqual(values(h, 'Body'), ['', ''])
})

await ok('undo after the cancel: the answered rows go back, the others already hold their old values', async () => {
  const sid = sheet([{ Answer: 'Old 0' }, { Answer: 'Old 1' }, { Answer: 'Old 2' }], ['Answer'])
  const id = insertRun('http', sid, ['Answer'])
  await seed('http', id, sid, ['Answer'])
  answer('http', id, sid, 0, [['Answer', 'New 0']])
  await cancel('http', id)
  assert.deepEqual(values(sid, 'Answer'), ['New 0', 'Old 1', 'Old 2'])
  assert.equal(journal('http', id)!.state, 'kept', 'the clear leaves the journal as it was')
  const out = await undoRun(uid, 'http', id)
  assert.ok('ok' in out, JSON.stringify(out))
  await until('the undo finished', () => journal('http', id)!.state === 'undone')
  assert.deepEqual(values(sid, 'Answer'), ['Old 0', 'Old 1', 'Old 2'])
  const j = journal('http', id)!
  assert.deepEqual([j.restored, j.skipped, j.gone], [3, 0, 0], 'the two put back count as already there')
})

done()
