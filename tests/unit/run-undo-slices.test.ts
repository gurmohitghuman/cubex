// Undoing a run (services/run-undo.ts) puts each journal row's cells back and queues the row once for every
// clean, formula and lookup column reading a restored column, in the slice's own transaction. With none, a slice
// is UNDO_SLICE_ROWS journal rows. With R of them, a slice holds UNDO_QUEUE_ROWS / (1 + R) rows (at least 1).
// Either way each commits with SQLite's own checkpoint off, its WAL copied back on the checkpoint worker's thread
// (lib/bulk-slices.ts): no checkpoint runs on this connection. A column reading
// other columns, one with auto-run off, an auto-run that costs and a deleted column's slot don't count. The real
// undo runs: each slice's size is read off the journal's cursor after it, and the checkpoints through the
// database's pragma calls. At 200,000 rows with random ids (as older sheets have) and 3 formulas reading the
// column, with disk syncs as the server has them and each checkpoint on the worker held 300 ms (a slow disk;
// bulk-wal-kit.ts): the event loop is never held 200 ms, and no checkpoint's sync runs on this thread.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, idle, sheet, cells, run, journal } = undoKit('run-undo-slices')

const { undoRun } = await import('../../server/src/services/run-undo')
const { UNDO_SLICE_ROWS, UNDO_QUEUE_ROWS } = await import('../../server/src/lib/constants')
const { startFormulaColumn, setFormulaColumnAutorun } = await import('../../server/src/services/formula-column')
const { formulaColumnFor } = await import('../../server/src/lib/formula-columns')
const { startCleanColumn } = await import('../../server/src/services/clean-column')
const { deleteUndoColumn } = await import('../../server/src/lib/run-undo/columns')
const { autoCheckpointHolders } = await import('../../server/src/lib/bulk-slices')
const { bulkWalKit } = await import('./bulk-wal-kit')
console.error = () => {}
// The undo measured on both OSes: enough rows for the WAL to reach the pause (WAL_BULK_PAUSE_FRAMES).
const SMALL_UNDO_ROWS = 20_000

// n rows whose Status and Answer hold earlier values, and an HTTP run that wrote new ones over `columns`.
async function undoable(n: number, columns: string[]) {
  const sid = sheet(Array.from({ length: n }, (_, i) => ({ Name: `n${i}`, Status: `s${i}`, Answer: `a${i}` })),
    ['Name', 'Status', 'Answer'])
  const runId = await run(sid, 'http', columns,
    Object.fromEntries(Array.from({ length: n }, (_, i) => [i, columns.map(c => `new ${c} ${i}`)])))
  return { sid, runId }
}
// A formula or clean column, filled (the sheet is busy until then).
const formula = async (sid: string, column: string, f: string) => {
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column, formula: f }), column)
  await idle(sid)
}
const clean = async (sid: string, source: string, column: string) => {
  assert.ok('ok' in await startCleanColumn(uid, sid, { source, cleaner: 'lowercase', column }), column)
  await idle(sid)
}

// The undo, watched: the journal rows each slice put back and, in order, each slice (with SQLite's own
// checkpoint setting as its commit saw it) and each WAL checkpoint it ran on this connection.
const { pragma } = db
const auto = () => pragma.call(db, 'wal_autocheckpoint', { simple: true }) as number
const putBack = db.prepare(`SELECT COUNT(*) FROM run_undo_rows r JOIN run_undos u ON u.id = r.undo_id
  WHERE u.id = ? AND r.row_id <= u.cursor`).pluck()
// Checkpoints are counted while the journal is undoing: dropping its rows afterwards checkpoints too.
const undoing = db.prepare('SELECT state = \'undoing\' FROM run_undos WHERE id = ?').pluck()
async function undo(sid: string, runId: string) {
  const undoId = journal('http', runId)!.id
  const sizes: number[] = [], events: string[] = []
  const autoBefore = auto()
  let back = 0
  const wrapped = db.transaction, pragmaNow = db.pragma
  db.transaction = ((fn: (...a: unknown[]) => unknown) => {
    const t = wrapped.call(db, fn)
    const w = ((...a: unknown[]) => t(...a)) as unknown as Record<string, unknown>
    for (const k of ['default', 'deferred', 'exclusive'] as const) w[k] = t[k]
    w.immediate = (...a: unknown[]) => {
      const out = t.immediate(...a)
      const now = putBack.get(undoId) as number
      // Only the undo's own slices: its journal's rows are dropped afterwards, slice by slice too (fewer then).
      if (now > back) {
        sizes.push(now - back)
        back = now
        events.push(`slice, auto-checkpoint ${auto() === 0 ? 'off' : 'on'}`)
      }
      return out
    }
    return w
  }) as unknown as typeof db.transaction
  db.pragma = ((source: string, options?: object) => {
    // NOOP only reads the WAL's size (lib/wal-checkpointer.ts).
    if (!source.startsWith('wal_checkpoint') || /noop/i.test(source) || !undoing.get(undoId)) {
      return pragmaNow.call(db, source, options)
    }
    events.push(source)
    return pragmaNow.call(db, source, options)
  }) as typeof db.pragma
  try {
    const out = await undoRun(uid, 'http', runId)
    assert.ok('ok' in out, JSON.stringify(out))
    await idle(sid)
  } finally {
    db.transaction = wrapped
    db.pragma = pragmaNow
  }
  assert.equal(journal('http', runId)!.state, 'undone')
  // Its journal's rows are dropped in the background, a bulk writer too: back on once that ends.
  while (autoCheckpointHolders() > 0) await new Promise(r => setTimeout(r, 5))
  assert.equal(auto(), autoBefore, 'SQLite\'s own checkpoint is as it was')
  return { sizes, events }
}
// n rows in slices of `size`: every slice full but the last.
const split = (n: number, size: number) =>
  Array.from({ length: Math.ceil(n / size) }, (_, i) => Math.min(size, n - i * size))
// What an undo of n rows does: slices of `size`, each committed with SQLite's own checkpoint off, and no
// checkpoint on this connection (they run on the worker).
const slicesOf = (n: number, size: number) => {
  const sizes = split(n, size)
  return { sizes, events: sizes.map(() => 'slice, auto-checkpoint off') }
}
// With no column reading them: UNDO_SLICE_ROWS a slice.
const plain = (n: number) => slicesOf(n, UNDO_SLICE_ROWS)
// With R reading columns: the queue budget's share.
const checkpointed = (n: number, readers: number) => slicesOf(n, Math.floor(UNDO_QUEUE_ROWS / (1 + readers)))
const expectUndo = async (u: { sid: string; runId: string }, want: { sizes: number[]; events: string[] }) => {
  const got = await undo(u.sid, u.runId)
  assert.deepEqual(got.sizes, want.sizes, 'rows per slice')
  assert.deepEqual(got.events, want.events, 'slices and checkpoints')
}
const N = UNDO_SLICE_ROWS + 1

await ok('no column reads the run\'s column: slices of UNDO_SLICE_ROWS, on the worker too', async () => {
  const u = await undoable(N, ['Answer'])
  await formula(u.sid, 'Who', '{{Name}} + "!"')
  // Auto-run on, then off through the column's own setting: its entry stays, reading Answer.
  await formula(u.sid, 'Off', '{{Answer}} + "?"')
  assert.ok('ok' in await setFormulaColumnAutorun(uid, u.sid, formulaColumnFor(u.sid, uid, 'Off')!, false))
  db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns)
    VALUES (?,?,?,'Hook','http',?)`).run(uuid(), uid, u.sid, JSON.stringify(['Answer']))
  await expectUndo(u, plain(N))
  assert.deepEqual([cells(u.sid, 'Answer')[0], cells(u.sid, 'Answer')[N - 1]], ['a0', `a${N - 1}`])
})

await ok('one formula reads Answer (another reads that formula): half the queue budget, checkpointed', async () => {
  const u = await undoable(N, ['Answer'])
  await formula(u.sid, 'F', '{{Answer}} + "!"')
  await formula(u.sid, 'F2', '{{F}} + "?"')
  await expectUndo(u, checkpointed(N, 1))
  assert.deepEqual([cells(u.sid, 'Answer')[0], cells(u.sid, 'Answer')[N - 1]], ['a0', `a${N - 1}`])
})

await ok('three read Status or Answer (one reads both, counted once): a quarter, checkpointed', async () => {
  const u = await undoable(N, ['Status', 'Answer'])
  await formula(u.sid, 'F', '{{Answer}} + "!"')
  await clean(u.sid, 'Status', 'Low')
  await formula(u.sid, 'Both', '{{Status}} + {{Answer}}')
  await clean(u.sid, 'Name', 'Name low')
  await expectUndo(u, checkpointed(N, 3))
  assert.deepEqual([cells(u.sid, 'Status')[N - 1], cells(u.sid, 'Answer')[N - 1]], [`s${N - 1}`, `a${N - 1}`])
})

await ok('twenty read Answer: slices of 95 rows, checkpointed (no floor brings big slices back)', async () => {
  const n = 95 * 2 + 1
  const u = await undoable(n, ['Answer'])
  for (let i = 0; i < 20; i++) await clean(u.sid, 'Answer', `Low ${i}`)
  const want = checkpointed(n, 20)
  assert.deepEqual(want.sizes, [95, 95, 1])
  await expectUndo(u, want)
})

await ok('a deleted column\'s slot doesn\'t count, though a column made later under its name is read', async () => {
  const u = await undoable(N, ['Answer', 'Status'])
  deleteUndoColumn(u.sid, uid, 'Status')
  await formula(u.sid, 'F', '{{Status}} + "!"')
  await expectUndo(u, plain(N))
  assert.deepEqual([cells(u.sid, 'Answer')[N - 1], cells(u.sid, 'Status')[N - 1]], [`a${N - 1}`, `new Status ${N - 1}`])
})

// The 200,000-row undo takes the Windows runner's disk over 11 minutes (a checkpoint cycle there takes about 12 s):
// Linux only, and the smaller case, which reaches the pause too, runs on both.
const { measure } = bulkWalKit()
for (const n of [SMALL_UNDO_ROWS, 200_000]) {
  const name = `${n.toLocaleString('en-US')} rows with random ids, 3 formulas reading the column: the loop is never `
    + 'held 200 ms, no checkpoint on this thread'
  if (n > SMALL_UNDO_ROWS && process.platform === 'win32') { console.log(`skip ${name} (Linux only)`); continue }
  await ok(name, async () => {
    const u = await undoable(n, ['Answer'])
    for (const k of [1, 2, 3]) await formula(u.sid, `F${k}`, `{{Answer}} + "${k}"`)
    // As once the formulas have followed the run's writes: nothing waits for them.
    db.prepare('DELETE FROM autorun_pending').run()
    let got!: Awaited<ReturnType<typeof undo>>
    await measure(`${n.toLocaleString('en-US')} rows, 3 formulas`, async () => { got = await undo(u.sid, u.runId) },
      { pause: true })
    assert.deepEqual(got.sizes, checkpointed(n, 3).sizes, 'rows per slice')
    assert.deepEqual([cells(u.sid, 'Answer')[0], cells(u.sid, 'Answer')[n - 1]], ['a0', `a${n - 1}`])
  })
}

done()
