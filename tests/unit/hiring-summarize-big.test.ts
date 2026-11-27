// A hiring check's summary (services/hiring-summarize.ts) on a Roles sheet of 1,000,000 rows (200,000 on Windows)
// at a quarter as many companies, 4 roles each: past HIRING_SUMMARY_MAX_COMPANIES (Linux and macOS) they are
// summed up in batches. The first pass makes a row per company; this thread never holds the event loop 200 ms on the
// CPU in one stretch (the slice budget the bulk writers keep; loop-watch.ts), and what the summary holds stays
// bounded whatever the number of companies: the heap after each full collection (the peak sampled between
// collections also counts garbage V8 hasn't collected yet, and swung from 70 to 270 MB between runs of one pass). A
// second pass writes no cell; a check whose run added roles at 10 companies writes only those companies' cells. Each
// pass prints its time, the loop's longest stretch and the CPU time in it (heldText), the longest transaction, the
// full collections and the heap after them, and the sampled peak. Where the server makes the -wal file its full size
// at start (Windows, lib/wal-file.ts; the probe's reset does the same), no commit grows it: on the Windows runner one
// that did waited 233 ms off the CPU here. Where writers wait for a running checkpoint (Windows and Linux), no slice
// begins while one runs (bulk-wal-kit.ts turnWritesSeen). On a Windows runner the stretch itself once went to 302 ms
// in a first pass, no transaction in it, where 23 runs on each OS held 27 to 94 ms.
import assert from 'node:assert/strict'
import { constants, performance, PerformanceObserver } from 'node:perf_hooks'
import v8 from 'node:v8'
import vm from 'node:vm'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { heldText, loopWatch, LOOP_LIMIT_MS, turnWritesSeen } from './bulk-wal-kit'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db, uid, ok, done, sheet } = undoKit('hiring-summarize-big')
const { summarizeHiring } = await import('../../server/src/services/hiring-summarize')
const { COMPANY_COLUMNS: C, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')
const { checkpointAsked, walCheckpointerIdle } = await import('../../server/src/lib/wal-checkpointer')
const { walFileSizing } = await import('../../server/src/lib/wal-file')
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)
const turns = turnWritesSeen()

const N = process.platform === 'win32' ? 200_000 : 1_000_000
const COMPANIES = N / 4
const HEAP_MB = 250
// A full collection on demand, for a clean start to each pass.
v8.setFlagsFromString('--expose-gc')
const fullGc = vm.runInNewContext('gc') as () => void
const TITLES = ['SDR', 'BDR', 'Account Executive', 'Sales Engineer', 'CSM', 'RevOps Analyst', 'VP Sales']

const roles = sheet([], Object.values(R))
const companies = sheet([], Object.values(C))
const sheets = { roles, companies }
const first = uuid(), later = uuid()

const t0 = performance.now()
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
const list = db.prepare(`INSERT INTO enrichment_list_rows (dest_row_id,user_id,dest_sheet_id,source_row_id,
  status_column,run_id,dedupe_key) VALUES (?,?,?,'src','Roles found',?,?)`)
// Role i, at company i % COMPANIES, its title and posted day those of role `like`.
const role = (i: number, runId: string | null, like = i) => {
  const k = i % COMPANIES
  const id = uuid()
  insert.run(id, roles, uid, i, JSON.stringify({ [R.title]: TITLES[like % TITLES.length], [R.company]: `Company ${k}`,
    [R.domain]: `c${k}.com`, [R.posted]: `2026-${String(1 + (like % 11)).padStart(2, '0')}-1${like % 10}`,
    [R.link]: `https://jobs.example/${i}`, [R.location]: 'Austin, TX' }))
  if (runId) list.run(id, uid, roles, runId, `key-${i}`)
}
db.transaction(() => { for (let i = 0; i < N; i++) role(i, i % 1000 === 0 ? first : null) }).immediate()
console.log(`      ${N.toLocaleString('en-US')} roles made in ${((performance.now() - t0) / 1000).toFixed(1)} s`)

async function measured(check: { label: string; sinceLabel: string | null; runId: string | null }) {
  await walCheckpointerIdle()
  probe.reset()
  fullGc()
  const base = process.memoryUsage().heapUsed
  let peak = base, held = base, fulls = 0
  const heap = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed) }, 20)
  const gcs = new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      if ((e.detail as { kind?: number } | undefined)?.kind !== constants.NODE_PERFORMANCE_GC_MAJOR) continue
      fulls++
      held = Math.max(held, process.memoryUsage().heapUsed)
    }
  })
  gcs.observe({ entryTypes: ['gc'] })
  turns.reset()
  const watch = loopWatch(probe.records)
  // Its threads started first: starting them isn't part of the pass.
  await watch.ready
  const start = performance.now()
  const s = await summarizeHiring(uid, sheets, check)
  assert.ok(!('gone' in s), 'both sheets are there')
  const ms = performance.now() - start
  const watched = watch()
  clearInterval(heap)
  await new Promise(resolve => setImmediate(resolve))
  gcs.disconnect()
  const w = probe.read()
  const grew = probe.records().filter(r => r.grew).length
  const peakMb = (peak - base) / 1e6
  // With no full collection meanwhile, the sampled peak is all it took.
  const grewMb = (fulls > 0 ? held - base : peak - base) / 1e6
  console.log(`      ${(ms / 1000).toFixed(1)} s, ${heldText(watched)}, ${w.transactions} `
    + `transactions (longest ${w.longestTransactionMs.toFixed(0)} ms), ${s.cellsWritten} cells written; held at `
    + `most ${grewMb.toFixed(0)} MB over ${fulls} full collections (sampled peak ${peakMb.toFixed(0)} MB); `
    + `${grew} grew the -wal file (${walFileSizing() ? 'made its full size first' : 'grown from empty'})`)
  const inside = watched.inside.map(transactionLine).join(' | ')
  console.log(`        in the stretch this thread held longest: ${inside || 'no transaction'}`)
  if (watched.cpuStretch.at !== watched.ownStretch.at) {
    const onCpu = watched.cpuInside.map(transactionLine).join(' | ')
    console.log(`        in the stretch on the CPU longest: ${onCpu || 'no transaction'}`)
  }
  console.log(`        ${turns.text()}`)
  if (walFileSizing()) assert.equal(grew, 0, 'transactions that grew the -wal file')
  turns.check()
  return { s, loopMs: watched.cpuMs, grewMb }
}

await ok(`the first pass over ${N.toLocaleString('en-US')} roles: a row per company, the loop never held `
  + `${LOOP_LIMIT_MS} ms, the heap well under the sheet's size`, async () => {
  const m = await measured({ label: '2026-11-11', sinceLabel: null, runId: first })
  assert.equal(m.s.roles, N)
  assert.equal(m.s.companiesNew, COMPANIES)
  assert.deepEqual(m.s.problems, [], 'every role grouped by its domain')
  assert.ok(m.loopMs < LOOP_LIMIT_MS, `this thread held the event loop ${m.loopMs.toFixed(0)} ms on the CPU`)
  assert.ok(m.grewMb < HEAP_MB, `heap grew ${m.grewMb.toFixed(0)} MB`)
  const one = JSON.parse(db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = 0').pluck()
    .get(companies) as string)
  assert.equal(one[C.openRoles], String(N / COMPANIES))
})

await ok('a second pass writes no cell, the loop never held long, the heap bounded', async () => {
  const m = await measured({ label: '2026-11-11', sinceLabel: null, runId: first })
  assert.equal(m.s.cellsWritten, 0)
  assert.equal(m.s.companiesNew, 0)
  assert.ok(m.loopMs < LOOP_LIMIT_MS, `this thread held the event loop ${m.loopMs.toFixed(0)} ms on the CPU`)
  assert.ok(m.grewMb < HEAP_MB, `heap grew ${m.grewMb.toFixed(0)} MB`)
})

await ok('a check whose run added roles at 10 companies writes only their cells', async () => {
  db.transaction(() => { for (let k = 0; k < 10; k++) role(N + k, later, k) }).immediate()
  const m = await measured({ label: '2026-11-18', sinceLabel: '2026-11-11', runId: later })
  assert.equal(m.s.newRoles, 10)
  assert.equal(m.s.companiesHiringMore, 10)
  // Each: Open roles, Links, New since and New roles (its titles are all shown already, its newest day stays).
  assert.equal(m.s.cellsWritten, 10 * 4)
  assert.ok(m.loopMs < LOOP_LIMIT_MS, `this thread held the event loop ${m.loopMs.toFixed(0)} ms on the CPU`)
  assert.ok(m.grewMb < HEAP_MB, `heap grew ${m.grewMb.toFixed(0)} MB`)
})

done()
