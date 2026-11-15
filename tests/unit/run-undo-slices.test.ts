// Undoing a run (services/run-undo.ts) puts each journal row's cells back and queues the row once for every
// clean, formula and lookup column reading a restored column, in the slice's own transaction. With none, a slice
// is UNDO_SLICE_ROWS journal rows, as before, and runs no checkpoint. With R of them, a slice holds
// UNDO_QUEUE_ROWS / (1 + R) rows (at least 1), commits with SQLite's own checkpoint off and is followed by a
// checkpoint of its own. A column reading other columns, one with auto-run off, an auto-run that costs and a
// deleted column's slot don't count. The real undo runs: each slice's size is read off the journal's cursor
// after it, and the checkpoints through the database's pragma calls. At 200,000 rows with random ids (as older
// sheets have) and 3 formulas reading the column, no slice holds the event loop 200 ms, with disk syncs off: the
// checkpoints sync on this thread in turns of their own (lib/slices.ts), and the slice after one starts the WAL
// over and syncs its new header in its commit. A slow disk makes a sync take 300 ms at times (as on the Windows
// runner), which says nothing of the slice's own work, the part its size sets.
import assert from 'node:assert/strict'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { sqliteWriteProbe, transactionLine, type TransactionRecord } from './sqlite-write-probe'
const { db, uid, ok, done, idle, sheet, cells, run, journal } = undoKit('run-undo-slices')

const { undoRun } = await import('../../server/src/services/run-undo')
const { UNDO_SLICE_ROWS, UNDO_QUEUE_ROWS } = await import('../../server/src/lib/constants')
const { startFormulaColumn, setFormulaColumnAutorun } = await import('../../server/src/services/formula-column')
const { formulaColumnFor } = await import('../../server/src/lib/formula-columns')
const { startCleanColumn } = await import('../../server/src/services/clean-column')
const { deleteUndoColumn } = await import('../../server/src/lib/run-undo/columns')
console.error = () => {}

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
// checkpoint setting as its commit saw it) and each WAL checkpoint it ran. With a probe on, also each slice's
// record (its time, whether it started the WAL over) and each checkpoint's time.
const { pragma } = db
const auto = () => pragma.call(db, 'wal_autocheckpoint', { simple: true }) as number
const putBack = db.prepare(`SELECT COUNT(*) FROM run_undo_rows r JOIN run_undos u ON u.id = r.undo_id
  WHERE u.id = ? AND r.row_id <= u.cursor`).pluck()
// Checkpoints are counted while the journal is undoing: dropping its rows afterwards checkpoints too.
const undoing = db.prepare('SELECT state = \'undoing\' FROM run_undos WHERE id = ?').pluck()
async function undo(sid: string, runId: string, probe?: ReturnType<typeof sqliteWriteProbe>) {
  const undoId = journal('http', runId)!.id
  const sizes: number[] = [], events: string[] = [], slices: TransactionRecord[] = [], checkpointMs: number[] = []
  const autoBefore = auto()
  let back = 0
  const wrapped = db.transaction, pragmaNow = db.pragma
  db.transaction = ((fn: (...a: unknown[]) => unknown) => {
    const t = wrapped.call(db, fn)
    const w = ((...a: unknown[]) => t(...a)) as unknown as Record<string, unknown>
    for (const k of ['default', 'deferred', 'exclusive'] as const) w[k] = t[k]
    w.immediate = (...a: unknown[]) => {
      const seen = probe?.records().length ?? 0
      const out = t.immediate(...a)
      const now = putBack.get(undoId) as number
      if (now !== back) {
        sizes.push(now - back)
        back = now
        events.push(`slice, auto-checkpoint ${auto() === 0 ? 'off' : 'on'}`)
        if (probe) slices.push(...probe.records().slice(seen))
      }
      return out
    }
    return w
  }) as unknown as typeof db.transaction
  db.pragma = ((source: string, options?: object) => {
    if (!source.startsWith('wal_checkpoint') || !undoing.get(undoId)) return pragmaNow.call(db, source, options)
    events.push(source)
    const t0 = performance.now()
    try { return pragmaNow.call(db, source, options) } finally { checkpointMs.push(performance.now() - t0) }
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
  assert.equal(auto(), autoBefore, 'SQLite\'s own checkpoint is as it was')
  return { sizes, events, slices, checkpointMs }
}
// n rows in slices of `size`: every slice full but the last.
const split = (n: number, size: number) =>
  Array.from({ length: Math.ceil(n / size) }, (_, i) => Math.min(size, n - i * size))
// What an undo of n rows does with no column reading them: UNDO_SLICE_ROWS a slice, SQLite's own checkpoint on.
const plain = (n: number) => {
  const sizes = split(n, UNDO_SLICE_ROWS)
  return { sizes, events: sizes.map(() => 'slice, auto-checkpoint on') }
}
// With R reading columns: slices of the queue budget's share, each committed with SQLite's own checkpoint off,
// then checkpointed.
const checkpointed = (n: number, readers: number) => {
  const sizes = split(n, Math.floor(UNDO_QUEUE_ROWS / (1 + readers)))
  return { sizes, events: sizes.flatMap(() => ['slice, auto-checkpoint off', 'wal_checkpoint(PASSIVE)']) }
}
const expectUndo = async (u: { sid: string; runId: string }, want: { sizes: number[]; events: string[] }) => {
  const got = await undo(u.sid, u.runId)
  assert.deepEqual(got.sizes, want.sizes, 'rows per slice')
  assert.deepEqual(got.events, want.events, 'slices and checkpoints')
}
const N = UNDO_SLICE_ROWS + 1

await ok('no column reads the run\'s column: slices of UNDO_SLICE_ROWS and no checkpoint, as before', async () => {
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

await ok('200,000 rows with random ids, 3 formulas reading the column: no slice holds the event loop 200 ms',
  async () => {
    const n = 200_000
    const u = await undoable(n, ['Answer'])
    for (const k of [1, 2, 3]) await formula(u.sid, `F${k}`, `{{Answer}} + "${k}"`)
    // As once the formulas have followed the run's writes: nothing waits for them.
    db.prepare('DELETE FROM autorun_pending').run()
    const probe = sqliteWriteProbe(db, process.env.DB_PATH!)
    probe.reset()
    const sync = pragma.call(db, 'synchronous', { simple: true }) as number
    pragma.call(db, 'synchronous = OFF')
    const loop = monitorEventLoopDelay({ resolution: 10 })
    loop.enable()
    const t0 = performance.now()
    let got: Awaited<ReturnType<typeof undo>>
    try { got = await undo(u.sid, u.runId, probe) } finally { pragma.call(db, `synchronous = ${sync}`) }
    const whole = performance.now() - t0
    loop.disable()
    const longest = Math.max(...got.slices.map(r => r.ms))
    const ms = (x: number) => `${x.toFixed(0)} ms`
    console.log(`      ${got.slices.length} slices of ${got.sizes[0]} rows, disk syncs off: the longest `
      + `${ms(longest)}; ${got.checkpointMs.length} checkpoints, the longest ${ms(Math.max(0, ...got.checkpointMs))}; `
      + `the event loop held at most ${ms(loop.max / 1e6 - 10)}; the whole undo ${(whole / 1000).toFixed(1)} s`)
    console.log(`      slowest slices: ${[...got.slices].sort((a, b) => b.ms - a.ms).slice(0, 5).map(transactionLine)
      .join(' | ')}`)
    assert.deepEqual(got.sizes, checkpointed(n, 3).sizes, 'rows per slice')
    assert.ok(longest < 200, `a slice held the event loop ${ms(longest)}`)
    assert.deepEqual([cells(u.sid, 'Answer')[0], cells(u.sid, 'Answer')[n - 1]], ['a0', `a${n - 1}`])
  })

done()
