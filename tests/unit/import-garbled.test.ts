// A CSV import keeps C1 characters and counts the cells that look garbled
// (text read with the wrong character set) as it writes them, keeping the
// first 10 as {"<row id>": {"<column>": "<value>"}} (null-prototype, values
// cut to 100 characters). import_csv and upload links answer garbled_cells,
// garbled_samples and one note only when there are such cells, so an import
// without them answers exactly as before, key order included. A formula
// reading a C1 cell gets it whole.
import assert from 'node:assert/strict'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, idle, sheet } = undoKit('import-garbled')
const { GarbledTally } = await import('../../server/src/lib/garbled-cells')
const { importSummary } = await import('../../server/src/services/csv-upload')
const { importCsv } = await import('../../server/src/services/csv-import')
const { scanCsvText } = await import('../../server/src/lib/csv-import-parse')
const { HEAVY_SLICE_ROWS } = await import('../../server/src/lib/constants')
const { IMPORT_GARBLED_SAMPLES, IMPORT_GARBLED_SAMPLE_CHARS } = await import('../../server/src/lib/constants-clean')
const { compileFormula } = await import('../../server/src/lib/formula/refs')
const { formulaRow, formulaCell } = await import('../../server/src/lib/formula/cells')
const { FormulaSandbox } = await import('../../server/src/lib/formula/sandbox')

const GARBLED = ['C1test\u0080\u0089end', 'FraudFighterâ\u0084¢', 'CODE Ã\u0089xitos']

await ok('the tally: __proto__ and constructor are ordinary keys, real text is not counted', () => {
  const t = new GarbledTally()
  t.check('r1', '__proto__', GARBLED[0])
  t.check('r1', 'constructor', GARBLED[1])
  t.check('r2', 'Name', 'José Łódź „Grüße“ €100')
  t.check('__proto__', 'x', GARBLED[2])
  assert.equal(t.cells, 3)
  assert.equal(Object.getPrototypeOf(t.samples), null)
  assert.equal(Object.getPrototypeOf(t.samples.r1), null)
  assert.deepEqual(Object.keys(t.samples), ['r1', '__proto__'])
  assert.deepEqual(Object.keys(t.samples.r1), ['__proto__', 'constructor'])
  assert.equal(t.samples.r1.__proto__, GARBLED[0])
  assert.equal(t.samples.r1.constructor, GARBLED[1])
  const [a, b, c] = GARBLED.map(v => JSON.stringify(v))
  assert.equal(JSON.stringify(t.samples), `{"r1":{"__proto__":${a},"constructor":${b}},"__proto__":{"x":${c}}}`)
})

await ok('the tally: counts every garbled cell, keeps the first 10, cuts each value (never half an emoji)', () => {
  const t = new GarbledTally()
  for (let i = 0; i < 25; i++) t.check(`r${i}`, 'A', `${GARBLED[1]} ${i}`)
  assert.equal(t.cells, 25)
  assert.deepEqual(Object.keys(t.samples), Array.from({ length: IMPORT_GARBLED_SAMPLES }, (_, i) => `r${i}`))
  const long = new GarbledTally()
  const emojiAtCut = 'a\u0085'.padEnd(IMPORT_GARBLED_SAMPLE_CHARS - 1, 'x') + '😀tail'
  long.check('r', 'A', emojiAtCut)
  long.check('r', 'B', 'Ã©'.repeat(IMPORT_GARBLED_SAMPLE_CHARS))
  assert.equal(long.samples.r.A, emojiAtCut.slice(0, IMPORT_GARBLED_SAMPLE_CHARS - 1))
  assert.equal(long.samples.r.B.length, IMPORT_GARBLED_SAMPLE_CHARS)
})

const base = {
  rowsImported: 3, startingRow: 0, newColumns: ['A'], truncatedCells: 0, droppedSeedRows: false,
  trashId: null, autoDedupe: null, rowsKept: 3, garbledCells: 0, garbledSamples: Object.create(null),
}
await ok('import_csv answers: no garbled keys without garbled cells, key order as before', () => {
  assert.deepEqual(Object.keys(importSummary(base, false, uid)),
    ['rows_imported', 'starting_row', 'new_columns', 'replaced'])
  const cut = importSummary({ ...base, truncatedCells: 2 }, false, uid)
  assert.deepEqual(Object.keys(cut),
    ['rows_imported', 'starting_row', 'new_columns', 'replaced', 'truncated_cells', 'note'])
  assert.equal(cut.note, '2 cell(s) were longer than 8000 characters and were cut to fit.')
})

await ok('import_csv answers: garbled cells add garbled_cells, garbled_samples and one note (with cut cells)', () => {
  const samples = Object.assign(Object.create(null), { r1: { A: GARBLED[1] } })
  const g = importSummary({ ...base, garbledCells: 3, garbledSamples: samples }, false, uid)
  assert.deepEqual(Object.keys(g),
    ['rows_imported', 'starting_row', 'new_columns', 'replaced', 'garbled_cells', 'garbled_samples', 'note'])
  assert.equal(g.garbled_cells, 3)
  assert.equal(g.garbled_samples, samples)
  assert.equal(g.note, '3 cell(s) look like text read with the wrong character set (garbled_samples shows the '
    + 'first ones). clean_column with the cleaner fix_encoding can repair them into a new column.')
  const both = importSummary({ ...base, truncatedCells: 1, garbledCells: 3, garbledSamples: samples }, false, uid)
  assert.deepEqual(Object.keys(both), ['rows_imported', 'starting_row', 'new_columns', 'replaced', 'truncated_cells',
    'garbled_cells', 'garbled_samples', 'note'])
  assert.equal(both.note, '1 cell(s) were longer than 8000 characters and were cut to fit. 3 cell(s) look like text '
    + 'read with the wrong character set (garbled_samples shows the first ones). clean_column with the cleaner '
    + 'fix_encoding can repair them into a new column.')
})

const rowIds = (sid: string) => db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(sid) as string[]
const cellsOf = (sid: string, col: string) => db.prepare(`SELECT json_extract(data, ?) FROM rows WHERE sheet_id = ?
  ORDER BY row_index`).pluck().all(`$."${col}"`, sid) as string[]
const csvOf = (header: string, rows: string[][]) =>
  [header, ...rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(','))].join('\n')

await ok('the import keeps C1 byte for byte, counts 3 garbled cells, keys samples by the new row ids', async () => {
  const sid = sheet([], [])
  const csv = csvOf('Name,Note',
    [[GARBLED[0], 'José'], ['Müller', GARBLED[1]], [GARBLED[2], 'plain'], ['Łódź', '€100']])
  const out = await importCsv(sid, uid, await scanCsvText(csv), false)
  await idle(sid)
  assert.ok('ok' in out, JSON.stringify(out))
  if (!('ok' in out)) return
  assert.deepEqual(cellsOf(sid, 'Name'), [GARBLED[0], 'Müller', GARBLED[2], 'Łódź'])
  assert.deepEqual(cellsOf(sid, 'Note'), ['José', GARBLED[1], 'plain', '€100'])
  const ids = rowIds(sid)
  assert.equal(out.ok.garbledCells, 3)
  assert.equal(JSON.stringify(out.ok.garbledSamples), JSON.stringify({
    [ids[0]]: { Name: GARBLED[0] }, [ids[1]]: { Note: GARBLED[1] }, [ids[2]]: { Name: GARBLED[2] },
  }))
})

await ok('the import counts past its first slice: the only garbled row is the last one', async () => {
  const sid = sheet([], [])
  const rows = Array.from({ length: HEAVY_SLICE_ROWS + 1 }, (_, i) => [`row ${i} José`])
  rows[HEAVY_SLICE_ROWS] = [GARBLED[1]]
  const out = await importCsv(sid, uid, await scanCsvText(csvOf('A', rows)), false)
  await idle(sid)
  assert.ok('ok' in out && out.ok.garbledCells === 1, JSON.stringify(out))
  if (!('ok' in out)) return
  const last = rowIds(sid)[HEAVY_SLICE_ROWS]
  assert.equal(JSON.stringify(out.ok.garbledSamples), JSON.stringify({ [last]: { A: GARBLED[1] } }))
  const none = await importCsv(sid, uid, await scanCsvText(csvOf('A', rows.slice(0, HEAVY_SLICE_ROWS + 1)
    .map((r, i) => (i === HEAVY_SLICE_ROWS ? ['nothing garbled'] : r)))), false)
  await idle(sid)
  assert.ok('ok' in none && none.ok.garbledCells === 0 && Object.keys(none.ok.garbledSamples).length === 0)
})

await ok('a formula reading a C1 cell gets it whole, and writes it back whole', async () => {
  const sb = await FormulaSandbox.open(compileFormula('{{A}} + "!"', ['A']))
  try {
    const got = sb.runRows([formulaRow([GARBLED[1]])], 100).outcomes[0]
    assert.ok(got.ok, JSON.stringify(got))
    assert.equal(formulaCell(got), `${GARBLED[1]}!`)
  } finally { sb.dispose() }
})

done()
