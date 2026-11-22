// Experiment (removed before review): hiring-summarize-big's first pass over 200,000 roles, repeated, with the
// -wal file before each pass either grown from empty (as the probe's reset leaves it, and a server after a start)
// or written to 64 MB with zeros and synced (preallocated). Prints each pass's longest commit and every commit that
// spent 40 ms or more off the CPU, then each way's totals.
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { loopWatch } from './bulk-wal-kit'
import { sqliteWriteProbe, transactionLine, type TransactionRecord } from './sqlite-write-probe'
const { db, uid, sheet } = undoKit('wal-growth-passes')
const { summarizeHiring } = await import('../../server/src/services/hiring-summarize')
const { COMPANY_COLUMNS: C, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')
const { checkpointAsked, walCheckpointerIdle } = await import('../../server/src/lib/wal-checkpointer')
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)

const N = 200_000
const COMPANIES = N / 4
const PASSES = Number(process.env.WAL_PASSES ?? 20)
const PREALLOC = 64 * 1024 * 1024
const TITLES = ['SDR', 'BDR', 'Account Executive', 'Sales Engineer', 'CSM', 'RevOps Analyst', 'VP Sales']
const roles = sheet([], Object.values(R))
const companies = sheet([], Object.values(C))
const sheets = { roles, companies }
const first = uuid()
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
const list = db.prepare(`INSERT INTO enrichment_list_rows (dest_row_id,user_id,dest_sheet_id,source_row_id,
  status_column,run_id,dedupe_key) VALUES (?,?,?,'src','Roles found',?,?)`)
db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const k = i % COMPANIES
    const id = uuid()
    insert.run(id, roles, uid, i, JSON.stringify({ [R.title]: TITLES[i % TITLES.length], [R.company]: `Company ${k}`,
      [R.domain]: `c${k}.com`, [R.posted]: `2026-${String(1 + (i % 11)).padStart(2, '0')}-1${i % 10}`,
      [R.link]: `https://jobs.example/${i}`, [R.location]: 'Austin, TX' }))
    if (i % 1000 === 0) list.run(id, uid, roles, first, `key-${i}`)
  }
}).immediate()

const wal = `${process.env.DB_PATH}-wal`
// From the -wal file's end to PREALLOC, zeros, synced. Only between passes: nothing else writes then.
function preallocate() {
  const fd = fs.openSync(wal, 'r+')
  const mb = Buffer.alloc(1024 * 1024)
  for (let at = fs.fstatSync(fd).size; at < PREALLOC; at += mb.length) {
    fs.writeSync(fd, mb, 0, Math.min(mb.length, PREALLOC - at), at)
  }
  fs.fsyncSync(fd)
  fs.closeSync(fd)
}

const ways = ['grown', 'zeroed'] as const
const totals = Object.fromEntries(ways.map(w => [w, { passes: 0, longest: [] as number[], loop: [] as number[],
  slow: 0 }]))
for (let p = 0; p < PASSES * ways.length; p++) {
  const way = ways[p % ways.length]
  db.transaction(() => { db.prepare('DELETE FROM rows WHERE sheet_id = ?').run(companies) }).immediate()
  await walCheckpointerIdle()
  probe.reset()
  if (way === 'zeroed') preallocate()
  const watch = loopWatch(probe.records)
  await watch.ready
  const t0 = performance.now()
  const s = await summarizeHiring(uid, sheets, { label: '2026-11-11', sinceLabel: null, runId: first })
  const ms = performance.now() - t0
  const { longest } = watch()
  if ('gone' in s || s.companiesNew !== COMPANIES) throw new Error(`pass ${p}: ${JSON.stringify(s).slice(0, 200)}`)
  const recs = probe.records()
  const top = recs.reduce<TransactionRecord | null>((a, r) => (!a || r.ms > a.ms ? r : a), null)
  const slow = recs.filter(r => r.ms - r.cpuMs >= 40)
  const t = totals[way]
  t.passes++
  t.longest.push(top?.ms ?? 0)
  t.loop.push(longest.ms)
  t.slow += slow.length
  console.log(`${way} pass ${p}: ${(ms / 1000).toFixed(1)} s, loop ${longest.ms.toFixed(0)} ms, ${recs.length} `
    + `commits, longest ${top ? transactionLine(top) : 'none'}; off the CPU 40 ms+: `
    + `${slow.map(transactionLine).join(' | ') || 'none'}; -wal ${(fs.statSync(wal).size / 1048576).toFixed(1)} MB`)
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
for (const way of ways) {
  const t = totals[way]
  console.log(`${way}: ${t.passes} passes; longest commit median ${med(t.longest).toFixed(1)} ms, max `
    + `${Math.max(...t.longest).toFixed(1)} ms; loop median ${med(t.loop).toFixed(0)} ms, max `
    + `${Math.max(...t.loop).toFixed(0)} ms; ${t.slow} commits 40 ms+ off the CPU`)
}
process.exit(0)
