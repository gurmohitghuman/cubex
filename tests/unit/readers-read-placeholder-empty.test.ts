// Every column worked out from other cells (the auto-run kinds that follow their inputs: clean, formula, lookup)
// reads a ⏳ exactly as it reads an empty cell, when it fills and when it follows a write; and a list job's words
// and a missing cell too. A run's clear relies on it (lib/placeholder-cells.ts): a ⏳ it empties whose cell held
// none of these, '' or a ⏳ before the run (KEPT_EMPTY_SQL) is told to none of them, which is right only because
// what they worked out then, and from the ⏳, is what they work out from ''. A kind added later must have a case
// here: the first case fails for any kind in DERIVED_KINDS (what follows its inputs) without one.
import assert from 'node:assert/strict'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, idle, sheet, cells, edit } = undoKit('readers-read-placeholder-empty')
const { DERIVED_KINDS } = await import('../../server/src/services/derived-kinds')
const { isFollowKind } = await import('../../server/src/lib/autorun-kick')
const { markAutorunInputs } = await import('../../server/src/lib/autorun-mark')
const { startDerivedFollow } = await import('../../server/src/services/derived-follow')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { startCleanColumn } = await import('../../server/src/services/clean-column')
const { startLookupColumn } = await import('../../server/src/services/lookup-column')
const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { LIST_MARK } = await import('../../server/src/lib/run-markers')
type AutorunKind = import('../../server/src/lib/autorun-rules').AutorunKind
startDerivedFollow()
console.error = () => {}

const WHY = 'A run\'s clear tells the columns reading its cells nothing about a ⏳ it empties when that cell read as '
  + 'empty before the run (lib/placeholder-cells.ts). That is right only if every such column reads a ⏳ exactly '
  + 'as it reads an empty cell. Make this kind read run markers as empty (services/derived-write.ts inputText), '
  + 'or make the clear tell it about every row it clears.'

// The cells of In: two ⏳ (one with blanks around it), a list job's words, no cell at all, the empty cell they must
// read like, and a value (the column does work something out).
const LISTING = `${LIST_MARK} Listing...`
const IN = [PLACEHOLDER, ` ${PLACEHOLDER} `, LISTING, undefined, '', 'x']
const EMPTY_LIKE_ROWS = [0, 1, 2, 3]
const EMPTY_ROW = 4
const VALUE_ROW = 5

// Starts a column of the kind reading In on the sheet, filled; answers its name.
type Case = (sid: string) => Promise<string>
const started = (out: object, name: string) => {
  assert.ok('ok' in out, `${name}: ${JSON.stringify(out)}`)
  return name
}
const CASES: Record<AutorunKind, Case | null> = {
  // Runs: they take rows that haven't run yet, not every write, and a ⏳ cell holds back a row (autorun-mark.ts).
  enrichment: null, http: null, waterfall: null,
  clean: async sid => started(await startCleanColumn(uid, sid, { source: 'In', cleaner: 'title_case', column: 'C' }),
    'C'),
  formula: async sid => started(await startFormulaColumn(uid, sid, { column: 'F', formula: '{{In}} + "|"' }), 'F'),
  // The other sheet holds a ⏳ key and a list job's words too: a lookup reading them as text would count them.
  lookup: async sid => {
    const other = sheet([PLACEHOLDER, LISTING, '', 'x'].map(Key => ({ Key })), ['Key'])
    return started(await startLookupColumn(uid, sid, { column: 'L', sourceColumn: 'In', otherSheetId: other,
      matchColumn: 'Key', returns: 'count' }), 'L')
  },
}

const queued = db.prepare('SELECT EXISTS (SELECT 1 FROM autorun_pending WHERE user_id = ?)').pluck()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Each of `placeholders`' cells in `column` reads like the empty row's, and the value's row differs.
function readsLikeEmpty(
  sid: string, column: string, kind: string, when: string, placeholders: number[], empty: number,
) {
  const got = cells(sid, column)
  const held = db.prepare(`SELECT json_extract(data, '$.In') FROM rows WHERE sheet_id = ? ORDER BY row_index`)
    .pluck().all(sid) as unknown[]
  for (const i of placeholders) {
    assert.equal(got[i], got[empty], `${when}, the ${kind} column worked "${got[i]}" out from `
      + `${held[i] === null ? 'no cell' : JSON.stringify(held[i])} but "${got[empty]}" from an empty cell. ${WHY}`)
  }
  assert.notEqual(got[VALUE_ROW], got[empty], `${when}, the ${kind} column worked nothing out from "x" (a broken case)`)
}

await ok('every kind that follows its inputs has a case here', () => {
  for (const k of DERIVED_KINDS) {
    assert.ok(CASES[k.id as AutorunKind], `The reader kind "${k.id}" has no case in this test. ${WHY}`)
  }
  for (const [kind, c] of Object.entries(CASES)) {
    assert.equal(c !== null, isFollowKind(kind), `"${kind}" ${isFollowKind(kind) ? 'follows its inputs but has '
      + 'no case here' : 'has a case here but doesn\'t follow its inputs'}. ${WHY}`)
  }
})

for (const k of DERIVED_KINDS) {
  const make = CASES[k.id as AutorunKind]
  if (!make) continue
  await ok(`a ${k.id} column reads a ⏳, a list job's words and no cell as it reads an empty cell, filling and `
    + 'following', async () => {
    const sid = sheet(IN.map(In => (In === undefined ? {} : { In })), ['In'])
    const column = await make(sid)
    await idle(sid)
    readsLikeEmpty(sid, column, k.id, 'Filling', EMPTY_LIKE_ROWS, EMPTY_ROW)
    // Each comes by a write the column follows: row 0 is emptied (to read like), row 1 gets a list job's words,
    // row 2 loses its cell, and rows 3 and 4 (no cell, empty) get a ⏳.
    edit(sid, 0, 'In', '')
    edit(sid, 1, 'In', LISTING)
    db.prepare(`UPDATE rows SET data = json_remove(data, '$.In') WHERE sheet_id = ? AND row_index = 2`).run(sid)
    edit(sid, 3, 'In', PLACEHOLDER)
    edit(sid, EMPTY_ROW, 'In', PLACEHOLDER)
    markAutorunInputs(sid, uid, ['In'], { indexes: [0, 1, 2, 3, EMPTY_ROW] })
    for (const end = Date.now() + 30_000; queued.get(uid) === 1 && Date.now() < end;) await sleep(10)
    assert.equal(queued.get(uid), 0, `the ${k.id} column never followed the writes`)
    readsLikeEmpty(sid, column, k.id, 'Following', [1, 2, 3, EMPTY_ROW], 0)
  })
}

done()
