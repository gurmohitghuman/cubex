// The row-write keys' ledger rules (lib/write-idempotency.ts): the cap keeps
// the newest IDEMPOTENT_WRITE_KEYS_MAX row-write keys whatever run keys came
// in, a few more when several share the second at its edge; a row-write key
// over a day old is free at once for a run start and for transfer_rows, which
// record it, so their retry replays; the sweep deletes expired row-write keys
// (never a run's) a slice at a time, appends in smaller slices, yielding
// between slices and checkpointing the WAL; the refusal's words live in one place.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import ledgerMod from '../../server/src/lib/write-idempotency'
import runLedgerMod from '../../server/src/lib/run-idempotency'
import transferMod from '../../server/src/services/rows-transfer'
import constMod from '../../server/src/lib/api-v1-constants'
import sharedMod from '../../server/src/services/data-plane-shared'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { pruneWriteKeys, writeWriteLedger } = ledgerMod as typeof import('../../server/src/lib/write-idempotency')
const { writeRunLedger, readRunLedger } = runLedgerMod as typeof import('../../server/src/lib/run-idempotency')
const { transferRows } = transferMod as typeof import('../../server/src/services/rows-transfer')
const { IDEMPOTENT_WRITE_KEYS_MAX: MAX, IDEMPOTENT_WRITE_PRUNE_APPENDS } =
  constMod as typeof import('../../server/src/lib/api-v1-constants')
const { IDEMPOTENCY_CONFLICT_MESSAGE } = sharedMod as typeof import('../../server/src/services/data-plane-shared')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const user = () => {
  const id = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(id, 'x')
  return id
}
const insert = db.prepare(`INSERT INTO data_operation_ledger (id, user_id, idempotency_key, operation_kind,
  request_hash, result_json, created_at) VALUES (?, ?, ?, ?, 'h', '{}', datetime('now', ?))`)
const has = (u: string, key: string) =>
  !!db.prepare('SELECT 1 FROM data_operation_ledger WHERE user_id = ? AND idempotency_key = ?').get(u, key)
const writeKeys = (u: string) => db.prepare(`SELECT count(*) FROM data_operation_ledger WHERE user_id = ?
  AND operation_kind IN ('rows_append', 'cells_update', 'cells_update_batch')`).pluck().get(u) as number
const age = (u: string, key: string, hours: number) => db.prepare(`UPDATE data_operation_ledger
  SET created_at = datetime('now', ?) WHERE user_id = ? AND idempotency_key = ?`).run(`-${hours} hours`, u, key)

// MAX - 1 row-write keys, a second apart and over 100 seconds old; `tieLast`
// gives the oldest two the same second.
function fill(u: string, tieLast: boolean) {
  db.transaction(() => {
    for (let i = 0; i < MAX - 1; i++) {
      const secs = 100 + (tieLast ? Math.min(i, MAX - 3) : i)
      insert.run(uuid(), u, `filler-${i}`, 'cells_update_batch', `-${secs} seconds`)
    }
  })()
}

await ok('the cap keeps the newest row-write keys whatever run keys came in since', () => {
  const u = user()
  fill(u, false)
  for (let j = 0; j < 50; j++) insert.run(uuid(), u, `run-${j}`, 'ai_run', `-${j} seconds`)
  writeWriteLedger(u, 'w-1', 'cells_update_batch', 'h', {})
  assert.equal(writeKeys(u), MAX, 'run keys take no row-write key\'s place')
  writeWriteLedger(u, 'w-2', 'cells_update_batch', 'h', {})
  assert.equal(writeKeys(u), MAX, 'the oldest went, the newest MAX stay')
  assert.ok(!has(u, `filler-${MAX - 2}`))
  assert.ok(has(u, `filler-${MAX - 3}`) && has(u, 'w-1') && has(u, 'w-2'))
  for (let j = 0; j < 50; j++) assert.ok(has(u, `run-${j}`), `run-${j}`)
})

await ok('keys sharing the second at the cap\'s edge all stay: the newest MAX are never cut', () => {
  const u = user()
  fill(u, true)
  writeWriteLedger(u, 'w-1', 'cells_update_batch', 'h', {})
  writeWriteLedger(u, 'w-2', 'cells_update_batch', 'h', {})
  assert.equal(writeKeys(u), MAX + 1)
  assert.ok(has(u, `filler-${MAX - 3}`) && has(u, `filler-${MAX - 2}`))
})

await ok('an expired row-write key: a run start takes it at once and records it; its retry replays', () => {
  const u = user()
  writeWriteLedger(u, 'k-run', 'rows_append', 'h-rows', { ids: [], first: 0, not_kept: [] })
  age(u, 'k-run', 23)
  assert.deepEqual(readRunLedger(u, 'k-run', 'h-run'), { conflict: true }, 'within a day it is still taken')
  age(u, 'k-run', 25)
  // Every run start reads its key this way (run-start-token.ts ledgerReplay, waterfall-token-dry.ts).
  assert.equal(readRunLedger(u, 'k-run', 'h-run'), null, 'the run starts')
  writeRunLedger(u, 'k-run', 'h-run', 'ai_run', { run_id: 'run-1' })
  assert.deepEqual(readRunLedger(u, 'k-run', 'h-run'), { replay: { run_id: 'run-1' } }, 'no second run')
})

await ok('an expired row-write key: transfer_rows takes it at once and records it; its retry replays', () => {
  const u = user(), t = uuid(), src = uuid(), dest = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(t, u, 'T')
  for (const [id, name] of [[src, 'Src'], [dest, 'Dest']]) {
    db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
      .run(id, t, u, name, JSON.stringify(['Name']))
  }
  const row = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  for (let i = 0; i < 3; i++) row.run(uuid(), src, u, i, JSON.stringify({ Name: `n${i}` }))
  const count = () => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(dest) as number
  writeWriteLedger(u, 'k-tr', 'rows_append', 'h-rows', { ids: [], first: 0, not_kept: [] })
  age(u, 'k-tr', 25)
  const request = {
    sourceSheetId: src, destinationSheetId: dest, operation: 'copy' as const, selection: { all: true as const },
    columnMode: 'create_missing' as const, columnModeOmitted: false, columnMapping: {}, idempotencyKey: 'k-tr',
  }
  const first = transferRows(u, request, 'mcp')
  assert.ok('ok' in first && !first.replayed && first.ok.copied === 3, JSON.stringify(first))
  const again = transferRows(u, request, 'mcp')
  assert.ok('ok' in again && again.replayed === true, JSON.stringify(again))
  assert.equal(count(), 3, 'copied once')
})

await ok('the sweep deletes row-write keys over a day old, never a run\'s', async () => {
  const u = user()
  writeRunLedger(u, 'run-old', 'h', 'ai_run', { run_id: 'r1' })
  age(u, 'run-old', 48)
  writeWriteLedger(u, 'bt-old', 'cells_update_batch', 'h', { updated: 1 })
  age(u, 'bt-old', 30)
  writeWriteLedger(u, 'bt-new', 'cells_update_batch', 'h', { updated: 1 })
  assert.ok(await pruneWriteKeys() >= 1)
  assert.ok(!has(u, 'bt-old'))
  assert.ok(has(u, 'run-old'), 'run keys keep their own rule')
  assert.ok(has(u, 'bt-new'))
})

await ok('the sweep goes a slice at a time, appends in small slices, yielding and checkpointing between', async () => {
  await pruneWriteKeys() // nothing else expired is left
  const u = user(), n = IDEMPOTENT_WRITE_PRUNE_APPENDS * 2 + 10
  db.transaction(() => {
    for (let i = 0; i < n; i++) insert.run(uuid(), u, `old-append-${i}`, 'rows_append', '-30 hours')
  })()
  const pragma = db.pragma
  const calls: string[] = []
  db.pragma = ((source: string, options?: unknown) => {
    calls.push(source)
    return (pragma as (s: string, o?: unknown) => unknown).call(db, source, options)
  }) as typeof db.pragma
  try {
    const sweep = pruneWriteKeys()
    assert.equal(writeKeys(u), n - IDEMPOTENT_WRITE_PRUNE_APPENDS, 'one slice, then it yields to requests')
    assert.equal(await sweep, n)
  } finally {
    db.pragma = pragma
  }
  assert.equal(writeKeys(u), 0)
  assert.ok(calls.filter(c => c === 'wal_checkpoint(PASSIVE)').length >= 3, JSON.stringify(calls))
})

await ok('the refusal\'s words are written once (data-plane-shared.ts), so no surface can drift', () => {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.ts$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(IDEMPOTENCY_CONFLICT_MESSAGE)) found.push(p)
    }
  }
  walk(path.join(process.cwd(), 'server', 'src'))
  assert.deepEqual(found.map(p => path.basename(p)), ['data-plane-shared.ts'])
})

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall row-write ledger checks passed')
