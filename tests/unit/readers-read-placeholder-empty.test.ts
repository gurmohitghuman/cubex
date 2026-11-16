// Every column worked out from other cells (the auto-run kinds that follow their inputs: clean, formula, lookup)
// reads a ⏳ exactly as it reads an empty cell, when it fills and when it follows a write. A run's clear relies on
// it (lib/placeholder-cells.ts): a ⏳ it empties that read as empty before the run is told to none of them, which
// is right only because what they worked out from the ⏳ is what they work out from ''. A kind added later must
// have a case here: the first case fails for any kind in DERIVED_KINDS (what follows its inputs) without one.
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
type AutorunKind = import('../../server/src/lib/autorun-rules').AutorunKind
startDerivedFollow()
console.error = () => {}

const WHY = 'A run\'s clear tells the columns reading its cells nothing about a ⏳ it empties when that cell read as '
  + 'empty before the run (lib/placeholder-cells.ts). That is right only if every such column reads a ⏳ exactly '
  + 'as it reads an empty cell. Make this kind read run markers as empty (services/derived-write.ts inputText), '
  + 'or make the clear tell it about every row it clears.'

// The cells of In: two ⏳ (one with blanks around it), the empty cell they must read like, and a value (the
// column does work something out).
const IN = [PLACEHOLDER, ` ${PLACEHOLDER} `, '', 'x']
const PLACEHOLDER_ROWS = [0, 1]
const EMPTY_ROW = 2

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
  // The other sheet holds a ⏳ key too: a lookup reading a ⏳ as text would count it.
  lookup: async sid => {
    const other = sheet([PLACEHOLDER, '', 'x'].map(Key => ({ Key })), ['Key'])
    return started(await startLookupColumn(uid, sid, { column: 'L', sourceColumn: 'In', otherSheetId: other,
      matchColumn: 'Key', returns: 'count' }), 'L')
  },
}

const queued = db.prepare('SELECT EXISTS (SELECT 1 FROM autorun_pending WHERE user_id = ?)').pluck()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Each ⏳ row's cell in `column` reads like the empty row's, and the value's row differs.
function readsLikeEmpty(
  sid: string, column: string, kind: string, when: string, placeholders: number[], empty: number,
) {
  const got = cells(sid, column)
  for (const i of placeholders) {
    assert.equal(got[i], got[empty], `${when}, the ${kind} column worked "${got[i]}" out from a ⏳ but "${got[empty]}" `
      + `from an empty cell. ${WHY}`)
  }
  assert.notEqual(got[3], got[empty], `${when}, the ${kind} column worked nothing out from "x" (a broken case)`)
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
  await ok(`a ${k.id} column reads a ⏳ as it reads an empty cell, filling and following`, async () => {
    const sid = sheet(IN.map(In => ({ In })), ['In'])
    const column = await make(sid)
    await idle(sid)
    readsLikeEmpty(sid, column, k.id, 'Filling', PLACEHOLDER_ROWS, EMPTY_ROW)
    // The ⏳ moves: the empty row gets one, the ⏳ rows are emptied, and the column follows those writes.
    edit(sid, EMPTY_ROW, 'In', PLACEHOLDER)
    for (const i of PLACEHOLDER_ROWS) edit(sid, i, 'In', '')
    markAutorunInputs(sid, uid, ['In'], { indexes: [...PLACEHOLDER_ROWS, EMPTY_ROW] })
    for (const end = Date.now() + 30_000; queued.get(uid) === 1 && Date.now() < end;) await sleep(10)
    assert.equal(queued.get(uid), 0, `the ${k.id} column never followed the writes`)
    readsLikeEmpty(sid, column, k.id, 'Following', [EMPTY_ROW], 0)
  })
}

done()
