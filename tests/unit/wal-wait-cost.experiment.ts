// Experiment only (removed before review): what writers waiting for a running checkpoint (as on Windows) costs a
// bulk job on Linux. A CSV import of IMPORT_ROWS rows, IMPORT_PAIRS times each way, alternating: its total time and
// its transactions with a checkpoint in flight (how long, how long off the CPU) against the rest. One IMPX line each.
import { performance } from 'node:perf_hooks'
import { undoKit } from './run-undo-kit'
import { sqliteWriteProbe, type TransactionRecord } from './sqlite-write-probe'
const { db, uid, sheet } = undoKit('wal-wait-cost')
const { importCsv } = await import('../../server/src/services/csv-import')
const { scanCsvText } = await import('../../server/src/lib/csv-import-parse')
const { checkpointAsked, closeWalCheckpointer, setWritesWaitForCheckpointsForTests, walCheckpointerIdle } =
  await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}

const N = Number(process.env.IMPORT_ROWS ?? 200_000)
const PAIRS = Number(process.env.IMPORT_PAIRS ?? 5)
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)
const csv = `Name,Answer,P\n${Array.from({ length: N }, (_, i) => `n${i},a${i},${'p'.repeat(200)}`).join('\n')}\n`
const off = (r: TransactionRecord) => r.ms - r.cpuMs
const sum = (xs: TransactionRecord[]) => ({ n: xs.length, ms: +xs.reduce((a, r) => a + r.ms, 0).toFixed(0),
  msMax: +Math.max(0, ...xs.map(r => r.ms)).toFixed(1), off: +xs.reduce((a, r) => a + off(r), 0).toFixed(0),
  offMax: +Math.max(0, ...xs.map(off)).toFixed(1), off10: xs.filter(r => off(r) >= 10).length })

for (let p = 0; p < PAIRS; p++) {
  for (const mode of p % 2 ? ['on', 'off'] : ['off', 'on']) {
    setWritesWaitForCheckpointsForTests(mode === 'on')
    const sid = sheet([{ Name: 'first' }], ['Name', 'Answer', 'P'])
    const scanned = await scanCsvText(csv)
    await walCheckpointerIdle()
    probe.reset()
    const t0 = performance.now()
    const out = await importCsv(sid, uid, scanned, false)
    const ms = performance.now() - t0
    await walCheckpointerIdle()
    const rs = probe.records()
    const rows = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(sid)
    console.log('IMPX ' + JSON.stringify({ mode, pass: p + 1, ok: 'ok' in out, rows, importMs: +ms.toFixed(0),
      overlap: sum(rs.filter(r => r.checkpointing || r.askedEnd)),
      apart: sum(rs.filter(r => !r.checkpointing && !r.askedEnd)) }))
    db.transaction(() => { db.prepare('DELETE FROM rows WHERE sheet_id = ?').run(sid) }).immediate()
  }
}
setWritesWaitForCheckpointsForTests(null)
await closeWalCheckpointer()
process.exit(0)
