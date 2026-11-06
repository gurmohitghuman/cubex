// A run that ends early (cancelled, failed in its worker, or failed to start)
// clears the ⏳ cells it left (lib/placeholder-cells.ts), and the answer those
// cells held before it is gone: clean and formula columns reading them work
// those rows out again. Exactly the cleared rows are queued (a row holding a
// real result isn't), the follow-up is told at once, and no auto-run that
// costs or sends requests hears of it (one reading the answer, one reading the
// formula). Each way a run ends early is driven through the code that ends it.
// Last, the follow-up runs by itself, as in the server, with no tick by hand.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import lifecycleMod from '../../server/src/services/run-lifecycle'
import aiEndMod from '../../server/src/services/ai-runner-lifecycle'
import httpEndMod from '../../server/src/services/http-runner-finalize'
import seedRunMod from '../../server/src/services/run-seed'
import busyMod from '../../server/src/lib/sheet-busy'
import cellsMod from '../../server/src/lib/placeholder-cells'
import writeMod from '../../server/src/lib/run-cells-write'
import markMod from '../../server/src/lib/autorun-mark'
import kickMod from '../../server/src/lib/autorun-kick'
import formulaMod from '../../server/src/services/formula-column'
import formulaKindMod from '../../server/src/services/formula-kind'
import fillMod from '../../server/src/services/derived-fill'
import cleanMod from '../../server/src/services/clean-column'
import followMod from '../../server/src/services/derived-follow'
import entryMod from '../../server/src/services/autorun-entry'
const { cancelRun } = lifecycleMod as typeof import('../../server/src/services/run-lifecycle')
const { markFailed } = aiEndMod as typeof import('../../server/src/services/ai-runner-lifecycle')
const { failHTTPRun } = httpEndMod as typeof import('../../server/src/services/http-runner-finalize')
const { seedThenEnqueue } = seedRunMod as typeof import('../../server/src/services/run-seed')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { seedProcessingPlaceholders } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { writeRunCells } = writeMod as typeof import('../../server/src/lib/run-cells-write')
const { markAutorunInputs } = markMod as typeof import('../../server/src/lib/autorun-mark')
const { onFollowQueued } = kickMod as typeof import('../../server/src/lib/autorun-kick')
const { startFormulaColumn } = formulaMod as typeof import('../../server/src/services/formula-column')
const { formulaKind } = formulaKindMod as typeof import('../../server/src/services/formula-kind')
const { waitForDerivedFill } = fillMod as typeof import('../../server/src/services/derived-fill')
const { startCleanColumn } = cleanMod as typeof import('../../server/src/services/clean-column')
const { derivedFollowTick, kickDerivedFollow } = followMod as typeof import('../../server/src/services/derived-follow')
const { entryFor } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { db, uid, ok, done, idle, sheet, cells } = undoKit('run-end-derived')
console.error = () => {}

type Kind = 'ai' | 'http'
const TABLE = { ai: 'ai_runs', http: 'http_runs' } as const
const GEN = 3
const NAME = { ai: 'an AI', http: 'an HTTP' } as const
const FORMULA = '{{Answer}} ? "has " + {{Answer}} : "empty"'
// Which follow-ups were told (lib/autorun-kick.ts); the last test lets them run on their own.
const told = new Set<string>()
onFollowQueued(id => { told.add(id) })

const until = async (what: string, cond: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !cond();) {
    if (Date.now() > end) throw new Error(`Timed out waiting until ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}
const rowIdsOf = (sid: string) => db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().all(sid) as string[]
const queued = (entryId: string) => db.prepare('SELECT row_id FROM autorun_pending WHERE autorun_id = ?')
  .pluck().all(entryId).sort() as string[]
const tick = async (sid: string, column: string) => { await derivedFollowTick(entryFor(sid, uid, column)!) }
const runOf = (kind: Kind, id: string) => db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id) as any

// Answers from an earlier run in Answer; a formula and a clean column reading it, worked out; an HTTP API
// auto-run reading Answer and an enrichment auto-run reading the formula (both paid or sending requests).
async function scene() {
  const sid = sheet([{ Name: 'ada', Answer: 'Old A' }, { Name: 'bob', Answer: 'Old B' },
    { Name: 'cy', Answer: 'Old C' }], ['Name', 'Answer', 'Status', 'Hook', 'Enriched'])
  const f = await startFormulaColumn(uid, sid, { column: 'F', formula: FORMULA })
  assert.ok('ok' in f, JSON.stringify(f))
  await waitForDerivedFill(formulaKind, f.ok.id, 30_000)
  const c = await startCleanColumn(uid, sid, { source: 'Answer', cleaner: 'lowercase', column: 'Low' })
  assert.ok('ok' in c, JSON.stringify(c))
  await idle(sid)
  assert.deepEqual(cells(sid, 'F'), ['has Old A', 'has Old B', 'has Old C'])
  assert.deepEqual(cells(sid, 'Low'), ['old a', 'old b', 'old c'])
  const paid = (status: string, kind: string, input: string) => {
    const id = uuid()
    db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns)
      VALUES (?,?,?,?,?,?)`).run(id, uid, sid, status, kind, JSON.stringify([input]))
    return id
  }
  return { sid, paid: [paid('Hook', 'http', 'Answer'), paid('Enriched', 'enrichment', 'F')] }
}

// A run on Answer (an HTTP run's extracted column; its status column is Status), as the worker has it.
function insertRun(kind: Kind, sid: string, status: string, placeholderWork: string | null): string {
  const id = uuid()
  if (kind === 'ai') {
    db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status,worker_generation,
      placeholder_work) VALUES (?,?,?,'Answer','p',?,?,?)`).run(id, sid, uid, status, GEN, placeholderWork)
  } else {
    db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,worker_generation,
      placeholder_work) VALUES (?,?,?,'{}',?,'Status',?,?)`).run(id, sid, uid, status, GEN, placeholderWork)
    db.prepare(`INSERT INTO http_column_associations (id,sheet_id,user_id,master_column_name,extracted_column_name,
      run_id) VALUES (?,?,?,'Status','Answer',?)`).run(uuid(), sid, uid, id)
  }
  return id
}
const runColumns = (kind: Kind) => (kind === 'ai' ? ['Answer'] : ['Status', 'Answer'])

// A run going: ⏳ on every row, row 0's real result written as a worker writes it (its follow-ups catch up).
async function runGoing(kind: Kind, sid: string): Promise<string> {
  const id = insertRun(kind, sid, 'running', null)
  await seedProcessingPlaceholders({ run: { kind, id }, sheetId: sid, userId: uid, columns: runColumns(kind),
    targets: null, lastRow: 2, live: () => true })
  db.transaction(() => {
    const result: Array<[string, string]> = kind === 'ai' ? [['Answer', 'New A']]
      : [['Status', '✅'], ['Answer', 'New A']]
    writeRunCells({ kind, id }, sid, uid, 0, result)
    markAutorunInputs(sid, uid, result.map(([c]) => c), { indexes: [0] })
  })()
  await tick(sid, 'F'); await tick(sid, 'Low')
  assert.deepEqual(cells(sid, 'F'), ['has New A', 'has Old B', 'has Old C'], 'seeding queues nothing')
  db.prepare('DELETE FROM autorun_pending').run()
  return id
}

// After the run ended early: what was queued and told, then the follow-ups run by hand.
async function followsUp(sid: string, paid: string[], firstRow: string) {
  const [f, low] = [entryFor(sid, uid, 'F')!.id, entryFor(sid, uid, 'Low')!.id]
  const ids = rowIdsOf(sid)
  const seen = { f: queued(f), low: queued(low), paid: paid.map(queued), told: [f, low].map(id => told.has(id)) }
  await tick(sid, 'F'); await tick(sid, 'Low')
  assert.deepEqual(cells(sid, 'Answer'), [firstRow, '', ''])
  assert.deepEqual(cells(sid, 'F'), [`has ${firstRow}`, 'empty', 'empty'])
  assert.deepEqual(cells(sid, 'Low'), [firstRow.toLowerCase(), '', ''])
  assert.deepEqual(seen.f, [ids[1], ids[2]].sort(), 'only the cleared rows are queued for the formula')
  assert.deepEqual(seen.low, [ids[1], ids[2]].sort(), 'only the cleared rows are queued for the clean column')
  assert.deepEqual(seen.paid, [[], []], 'no paid auto-run was queued')
  assert.deepEqual(seen.told, [true, true], 'the follow-ups were told at once')
  assert.deepEqual(paid.map(queued), [[], []], 'the formula\'s own writes reach no paid auto-run either')
}

for (const kind of ['ai', 'http'] as const) {
  await ok(`${NAME[kind]} run cancelled: formula and clean columns work the cleared rows out again`, async () => {
    const { sid, paid } = await scene()
    const id = await runGoing(kind, sid)
    told.clear()
    assert.deepEqual(await cancelRun(kind, id, uid), { ok: true })
    await until('the cancel cleared its cells', () => runOf(kind, id).placeholder_work === null)
    await followsUp(sid, paid, 'New A')
  })

  await ok(`${NAME[kind]} run its worker failed: the same`, async () => {
    const { sid, paid } = await scene()
    const id = await runGoing(kind, sid)
    told.clear()
    if (kind === 'ai') await markFailed(id, GEN, runOf(kind, id), 'the model went away')
    else await failHTTPRun(runOf(kind, id), id, GEN, new Error('the API went away'))
    assert.equal(runOf(kind, id).status, 'failed')
    assert.equal(runOf(kind, id).placeholder_work, null)
    await followsUp(sid, paid, 'New A')
  })

  await ok(`${NAME[kind]} rerun of rows 1 and 2 that failed to start: the same; row 0 was never in it`, async () => {
    const { sid, paid } = await scene()
    const id = insertRun(kind, sid, 'pending', 'seeding')
    told.clear()
    const out = await withSheetBusy(sid, 'starting a run', async () => {
      seedThenEnqueue({ kind, runId: id, sheetId: sid, userId: uid, columns: runColumns(kind), targets: [1, 2],
        lastRow: 2, enqueue: async () => { throw new Error('the queue is down') } })
    })
    assert.ok(!(out && 'busy' in out))
    await until('the start failed and cleared its cells', () => runOf(kind, id).status === 'failed'
      && runOf(kind, id).placeholder_work === null)
    assert.match(runOf(kind, id).error_message, /could not start: the queue is down/)
    await followsUp(sid, paid, 'Old A')
  })
}

await ok('in the server the follow-up runs by itself after a cancel, no tick by hand', async () => {
  const { sid } = await scene()
  const id = await runGoing('http', sid)
  onFollowQueued(kickDerivedFollow)
  assert.deepEqual(await cancelRun('http', id, uid), { ok: true })
  await until('the formula followed the cleared cells', () =>
    JSON.stringify(cells(sid, 'F')) === JSON.stringify(['has New A', 'empty', 'empty']), 5_000)
  await until('the clean column followed', () =>
    JSON.stringify(cells(sid, 'Low')) === JSON.stringify(['new a', '', '']), 5_000)
})

done()
