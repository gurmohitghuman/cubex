// A run that ends early puts its ⏳ cells back to what they held before it
// (lib/run-undo/clear-back.ts), so a lookup filling from one of its columns
// in another sheet must not read them half-way: while the clear goes on the
// run still holds its columns (lib/run-locked-columns.ts `clearing`), and a
// paused run that ended counts as a change (lookup-fill-changes.ts). Either
// way the fill starts over, and every row comes from one version: the
// answers put back. A run worker's clear (a failed run) holds them too, from
// the database. Auto-run's batch runs keep their exception while clearing,
// and a waterfall's lookup step waits for a ⏳ the clear will put back.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { lookupWaitKit } from './lookup-wait-kit'
import fillMod from '../../server/src/services/derived-fill'
import colMod from '../../server/src/services/lookup-column'
import waitMod from '../../server/src/services/lookup-fill-wait'
import lifecycleMod from '../../server/src/services/run-lifecycle'
import cellsMod from '../../server/src/lib/placeholder-cells'
import placeholdersMod from '../../server/src/lib/run-placeholders'
import waterfallMod from '../../server/src/services/waterfall-lookup-wait'
const { derivedFillWait } = fillMod as typeof import('../../server/src/services/derived-fill')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { readsFilling } = waitMod as typeof import('../../server/src/services/lookup-fill-wait')
const { cancelRun } = lifecycleMod as typeof import('../../server/src/services/run-lifecycle')
const { seedProcessingPlaceholders, PLACEHOLDER } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { clearRunPlaceholders } = placeholdersMod as typeof import('../../server/src/lib/run-placeholders')
const { cellStillFilling } = waterfallMod as typeof import('../../server/src/services/waterfall-lookup-wait')
const k = lookupWaitKit('lookup-run-clear')
const { db, uid, ok, done, place, cells, statusOf, until, lookup, rec, runNote, oneRowASlice } = k
console.error = () => {}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const runOf = (id: string) => db.prepare('SELECT status, placeholder_work FROM http_runs WHERE id = ?').get(id) as
  { status: string; placeholder_work: string | null }
// Sheet `o` with n rows instead of its 3: Email u<k>@a.com and Name "Old <k>", k counting up (or down, so the
// rows a lookup from place()'s u0..u2 matches come last, in the clear's last slice).
const other = (n: number, down = false) => {
  const o = place().sid
  db.prepare('DELETE FROM rows WHERE sheet_id = ?').run(o)
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const at = down ? n - 1 - i : i
      ins.run(uuid(), o, uid, i, JSON.stringify({ Email: `u${at}@a.com`, Name: `Old ${at}` }))
    }
  }).immediate()
  return o
}
// A rerun of Name on o as a worker has it: ⏳ on every row, what Name held kept in its journal first.
const rerun = async (o: string, status: string, autorun = false) => {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, autorun_id)
    VALUES (?, ?, ?, '{}', ?, 'Name', ?)`).run(id, o, uid, status, autorun ? uuid() : null)
  const last = db.prepare('SELECT MAX(row_index) FROM rows WHERE sheet_id = ?').pluck().get(o) as number
  await seedProcessingPlaceholders({ run: { kind: 'http', id }, sheetId: o, userId: uid, columns: ['Name'],
    targets: null, lastRow: last, live: () => true })
  return id
}
// "Look up every row again" for the lookup Who on a.
const again = async (a: string, o: string) => {
  const out = await startLookupColumn(uid, a, { column: 'Who', sourceColumn: 'Email', otherSheetId: o,
    matchColumn: 'Email', returns: 'value', returnColumn: 'Name' })
  assert.ok('ok' in out, JSON.stringify(out))
}
const OLD = ['Old 0', 'Old 1', 'Old 2']
// The lookup filling again, one row a slice, and after its first row the rerun going on (as a resume does:
// running, its worker_generation moved): the fill waits for it, from its first row.
const fillThenResume = async (a: string, o: string, id: string, run: string) => {
  const slow = oneRowASlice(id, () => {
    db.prepare(`UPDATE http_runs SET status = 'running', worker_generation = worker_generation + 1
      WHERE id = ?`).run(run)
  })
  try {
    await again(a, o)
    await until('it waits for the run', () => derivedFillWait(id) === runNote(o, 'Name'))
  } finally { slow.restore() }
  assert.equal(rec(id)!.fill_cursor, 0)
}

await ok('a paused rerun cancelled while a lookup fills from it: the fill starts over, every row gets the answers '
  + 'put back', async () => {
  const a = place().sid, o = other(4_000)
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  assert.deepEqual(cells(a, 'Who'), OLD)
  const run = await rerun(o, 'paused')
  // The fill doesn't wait for a paused run: it reads the ⏳ as empty. After its first row, the run is cancelled.
  let cancelled: Promise<unknown> | null = null
  const slow = oneRowASlice(id, () => { setImmediate(() => { cancelled = cancelRun('http', run, uid) }) })
  try {
    await again(a, o)
    await until('it is done', () => statusOf(a, 'Who') === 'done')
  } finally { slow.restore() }
  assert.deepEqual(await cancelled, { ok: true })
  await until('the clear is done', () => runOf(run).placeholder_work === null)
  assert.deepEqual(cells(a, 'Who'), OLD)
  assert.equal(rec(id)!.filled_rows, 3)
})

await ok('a running rerun that fails: the fill waits until its clear (in the worker\'s thread) has put the '
  + 'cells back', async () => {
  const a = place().sid, o = place().sid
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  const run = await rerun(o, 'paused')
  await fillThenResume(a, o, id, run)
  // As a worker's failure leaves it while that thread clears its cells: failed, still clearing.
  db.prepare(`UPDATE http_runs SET status = 'failed', placeholder_work = 'clearing' WHERE id = ?`).run(run)
  await sleep(1_600)
  assert.equal(statusOf(a, 'Who'), 'filling', 'it does not finish while the cells are being put back')
  assert.equal(derivedFillWait(id), runNote(o, 'Name'))
  assert.deepEqual(cells(o, 'Name'), [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER])
  await clearRunPlaceholders('http', run)
  await until('it is done', () => statusOf(a, 'Who') === 'done')
  assert.deepEqual(cells(o, 'Name'), ['N0', 'N1', 'N2'])
  assert.deepEqual(cells(a, 'Who'), ['N0', 'N1', 'N2'])
})

// The run's clear held after its first slice until release(), nothing in it changed: the heartbeat it runs
// right after each slice (lib/run-placeholders.ts) arms the hold, and the one turn its loop then waits for
// (setImmediate, lib/slices.ts yieldToRequests) is kept back. held: the hold has engaged.
function holdClearAfterFirstSlice(run: string) {
  const prepare = db.prepare, immediate = globalThis.setImmediate
  let armed = false, held = false, release!: () => void
  const released = new Promise<void>(r => { release = r })
  const beat = "UPDATE http_runs SET updated_at = datetime('now') WHERE id = ?"
  db.prepare = ((sql: string) => {
    const st = prepare.call(db, sql)
    if (sql !== beat) return st
    return new Proxy(st, { get(t, key) {
      if (key === 'run') return (...a: unknown[]) => { const r = t.run(...a); if (a[0] === run) armed = true; return r }
      const v = Reflect.get(t, key)
      return typeof v === 'function' ? v.bind(t) : v
    } })
  }) as typeof db.prepare
  globalThis.setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    if (!armed) return immediate(fn, ...args)
    armed = false; held = true
    globalThis.setImmediate = immediate
    void released.then(() => immediate(fn, ...args))
    return immediate(() => {})
  }) as typeof setImmediate
  return { held: () => held, release: () => { db.prepare = prepare; globalThis.setImmediate = immediate; release() } }
}

await ok('a running rerun cancelled, its clear held between two slices with the rows it matches still ⏳: the fill '
  + 'waits for the clear, then every row gets the answers put back', async () => {
  const a = place().sid, o = other(4_000, true)
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  const run = await rerun(o, 'paused')
  await fillThenResume(a, o, id, run)
  const hold = holdClearAfterFirstSlice(run)
  try {
    assert.deepEqual(await cancelRun('http', run, uid), { ok: true })
    await until('the clear is held after its first slice', hold.held)
    // Its first slice put rows back; the 3 the lookup matches (the last ones) still hold ⏳.
    const name = db.prepare(`SELECT json_extract(data, '$.Name') FROM rows WHERE sheet_id = ?
      AND json_extract(data, '$.Email') = ?`).pluck()
    assert.equal(name.get(o, 'u3999@a.com'), 'Old 3999')
    assert.deepEqual(['u0', 'u1', 'u2'].map(e => name.get(o, `${e}@a.com`)), [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER])
    // Past two of the fill's looks (every LOOKUP_WAIT_POLL_MS): it still waits.
    await sleep(1_200)
    assert.equal(statusOf(a, 'Who'), 'filling', 'the fill does not go on while the clear is held')
    assert.equal(derivedFillWait(id), runNote(o, 'Name'))
  } finally { hold.release() }
  await until('it is done', () => statusOf(a, 'Who') === 'done')
  assert.equal(runOf(run).placeholder_work, null)
  assert.deepEqual(cells(a, 'Who'), OLD)
})

await ok('while a run is clearing: it holds the columns it wrote, an auto-run batch run as a batch run', async () => {
  const a = place().sid, o = place().sid
  const id = await lookup(a, o, 'Who', 'value', 'Name')
  for (const autorun of [false, true]) {
    const run = await rerun(o, 'running', autorun)
    db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing' WHERE id = ?`).run(run)
    assert.deepEqual(readsFilling(rec(id)!), { column: 'Name', byRun: true, batch: autorun })
    await clearRunPlaceholders('http', run)
    assert.equal(readsFilling(rec(id)!), null)
  }
})

await ok('a waterfall\'s lookup step waits for a ⏳ a clear will put back, not for a paused run\'s', async () => {
  const o = place().sid
  const run = await rerun(o, 'running')
  db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing' WHERE id = ?`).run(run)
  assert.equal(cellStillFilling(PLACEHOLDER, o, uid, 'Name'), true)
  await clearRunPlaceholders('http', run)
  assert.equal(cellStillFilling(PLACEHOLDER, o, uid, 'Name'), false)
  db.prepare(`UPDATE http_runs SET status = 'paused' WHERE id = ?`).run(run)
  assert.equal(cellStillFilling(PLACEHOLDER, o, uid, 'Name'), false)
})

done()
