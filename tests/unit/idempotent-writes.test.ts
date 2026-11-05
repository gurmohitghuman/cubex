// Over 200 lines: one fixture and every rule of the row-write keys, read top to bottom.
// Idempotency keys on row writes (services/rows-write-keyed.ts, lib/write-idempotency.ts):
// a replay returns the first answer and writes nothing; other arguments are
// refused; the hash ignores key order and value spelling but not the sheet; a
// one-row update's sheet_id is the row's; keys are per user, last a day and
// share the run ledger's namespace without crowding run keys out; stored
// answers stay small. The race (two connections at once) is
// idempotent-writes-race.test.ts.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import keyedMod from '../../server/src/services/rows-write-keyed'
import rowsMod from '../../server/src/services/rows-write'
import ledgerMod from '../../server/src/lib/write-idempotency'
import runLedgerMod from '../../server/src/lib/run-idempotency'
import transferLedgerMod from '../../server/src/services/transfer-ledger'
import constMod from '../../server/src/lib/api-v1-constants'
import sharedMod from '../../server/src/services/data-plane-shared'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { appendRowsKeyed, patchRowKeyed, batchUpdateKeyed, idempotencyKeyOf } =
  keyedMod as typeof import('../../server/src/services/rows-write-keyed')
const { appendRows, deleteRowsByIds } = rowsMod as typeof import('../../server/src/services/rows-write')
const { pruneWriteKeys, writeRequestHash, canonicalJson } =
  ledgerMod as typeof import('../../server/src/lib/write-idempotency')
const { writeRunLedger, readRunLedger } = runLedgerMod as typeof import('../../server/src/lib/run-idempotency')
const { writeTransferLedger } = transferLedgerMod as typeof import('../../server/src/services/transfer-ledger')
const { IDEMPOTENT_WRITE_KEYS_MAX, IDEMPOTENT_WRITE_ROW_BYTES } =
  constMod as typeof import('../../server/src/lib/api-v1-constants')
const { parseCellMap } = sharedMod as typeof import('../../server/src/services/data-plane-shared')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

let failures = 0
const ok = (label: string, fn: () => void) => {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), other = uuid(), tid = uuid(), A = uuid(), B = uuid()
for (const u of [uid, other]) db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(u, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
for (const [id, name] of [[A, 'A'], [B, 'B']]) {
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
    .run(id, tid, uid, name, JSON.stringify(['Name', 'Email', 'Big']))
}
const count = (s: string) => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(s) as number
const version = (s: string) => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(s) as number
const cell = (id: string, c: string) => db.prepare('SELECT json_extract(data, ?) FROM rows WHERE id = ?')
  .pluck().get(`$."${c}"`, id) as string | null
const entry = (key: string) => db.prepare('SELECT * FROM data_operation_ledger WHERE idempotency_key = ?')
  .get(key) as { result_json: string; operation_kind: string; created_at: string } | undefined
// A keyed write's { ok, replayed }, or a plain write's ok part.
const done = <T>(r: T | { fail: string }): T => {
  assert.ok(!('fail' in (r as object)), JSON.stringify(r))
  return r as T
}
const okOf = <T>(r: { ok: T } | { fail: string }): T => done(r).ok

ok('the key is optional, a string of 1-200 characters', () => {
  assert.deepEqual(idempotencyKeyOf(undefined), {})
  assert.deepEqual(idempotencyKeyOf('k1'), { key: 'k1' })
  for (const bad of ['', 'x'.repeat(201), 7, null]) assert.ok('error' in idempotencyKeyOf(bad), String(bad))
})

ok('the hash: key order and the null/number spellings the cells normalize to are the same call', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  assert.equal(writeRequestHash('rows_append', { sheet_id: A, rows: [{ Name: 'a', Email: '' }] }),
    writeRequestHash('rows_append', { rows: [{ Email: '', Name: 'a' }], sheet_id: A }))
  assert.notEqual(writeRequestHash('rows_append', { sheet_id: A, rows: [{ Name: 'a' }] }),
    writeRequestHash('rows_append', { sheet_id: B, rows: [{ Name: 'a' }] }))
  assert.notEqual(writeRequestHash('rows_append', { sheet_id: A, rows: [{ Name: 'a' }, { Name: 'b' }] }),
    writeRequestHash('rows_append', { sheet_id: A, rows: [{ Name: 'b' }, { Name: 'a' }] }))
  // What the routes and tools hash: the cells as parsed (null is '', 1 is '1', true is 'true').
  const cellsOf = (d: unknown) => { const p = parseCellMap(d, 80); assert.ok('cells' in p); return p.cells }
  assert.equal(writeRequestHash('cells_update', { row_id: 'r', cells: cellsOf({ a: 1, b: null, c: true }) }),
    writeRequestHash('cells_update', { row_id: 'r', cells: cellsOf({ c: 'true', b: '', a: '1' }) }))
  const proto = JSON.parse('{"__proto__": "x"}')
  assert.notEqual(canonicalJson({ cells: proto }), canonicalJson({ cells: {} }), 'a "__proto__" column counts')
})

let firstRows: Array<{ id: string; index: number }> = []
ok('append: the first call writes; the same key and arguments replay it and write nothing', () => {
  const first = done(appendRowsKeyed(A, uid, [{ Name: 'Ann', Email: 'a@x.io' }, { Name: 'Bo' }], 'ap-1', 'mcp'))
  assert.equal(first.replayed, false)
  firstRows = first.ok.answer.rows as typeof firstRows
  assert.equal(firstRows.length, 2)
  const v = version(A)
  // The same rows with their keys in another order: the same call.
  const again = done(appendRowsKeyed(A, uid, [{ Email: 'a@x.io', Name: 'Ann' }, { Name: 'Bo' }], 'ap-1', 'rest'))
  assert.equal(again.replayed, true)
  assert.deepEqual(again.ok.answer, first.ok.answer)
  assert.equal(count(A), 2)
  assert.equal(version(A), v, 'a replay bumps nothing')
})

ok('append: the same key with other rows, or on another sheet, is refused and writes nothing', () => {
  assert.deepEqual(appendRowsKeyed(A, uid, [{ Name: 'Cy' }], 'ap-1', 'mcp'), { fail: 'idempotency_conflict' })
  assert.deepEqual(appendRowsKeyed(B, uid, [{ Name: 'Ann', Email: 'a@x.io' }, { Name: 'Bo' }], 'ap-1', 'mcp'),
    { fail: 'idempotency_conflict' })
  assert.equal(count(A), 2)
  assert.equal(count(B), 0)
})

ok('append: a failed call stores nothing, so its retry runs', () => {
  const bad = appendRowsKeyed(A, uid, [{ Nope: 'x' }], 'ap-2', 'mcp')
  assert.ok('fail' in bad && bad.fail === 'unknown_columns')
  assert.equal(entry('ap-2'), undefined)
})

ok('no key: two appends write twice, as before', () => {
  okOf(appendRows(B, uid, [{ Name: 'x' }]))
  okOf(appendRows(B, uid, [{ Name: 'x' }]))
  assert.equal(count(B), 2)
})

ok('keys are per user: another user\'s same key is its own', () => {
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run('t-other', other, 'T')
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
    .run('s-other', 't-other', other, 'S', JSON.stringify(['Name']))
  const theirs = done(appendRowsKeyed('s-other', other, [{ Name: 'z' }], 'ap-1', 'mcp'))
  assert.equal(theirs.replayed, false)
  assert.equal(count('s-other'), 1)
})

ok('one-row update: replays the first answer, the row\'s sheet_id given or not; another sheet is refused', () => {
  const row = firstRows[0].id
  const first = done(patchRowKeyed(row, uid, { Email: 'new@x.io' }, undefined, 'up-1', 'mcp'))
  assert.equal(first.replayed, false)
  assert.equal((first.ok.data as Record<string, string>).Email, 'new@x.io')
  db.prepare("UPDATE rows SET data = json_set(data, '$.Email', 'later') WHERE id = ?").run(row)
  const again = done(patchRowKeyed(row, uid, { Email: 'new@x.io' }, A, 'up-1', 'rest'))
  assert.equal(again.replayed, true)
  assert.deepEqual(again.ok, first.ok, 'the first answer, not the row now')
  assert.equal(cell(row, 'Email'), 'later', 'a replay writes nothing')
  assert.deepEqual(patchRowKeyed(row, uid, { Email: 'new@x.io' }, B, 'up-1', 'mcp'), { fail: 'idempotency_conflict' })
  assert.deepEqual(patchRowKeyed(row, uid, { Email: 'other' }, undefined, 'up-1', 'mcp'),
    { fail: 'idempotency_conflict' })
  assert.deepEqual(patchRowKeyed(row, uid, { Email: 'x' }, B, 'up-2', 'mcp'), { fail: 'not_in_sheet' })
})

ok('one-row update: a replay still answers once the row is gone', () => {
  const row = firstRows[1].id
  done(patchRowKeyed(row, uid, { Email: 'b@x.io' }, A, 'up-3', 'mcp'))
  okOf(deleteRowsByIds(A, uid, [row]))
  const again = done(patchRowKeyed(row, uid, { Email: 'b@x.io' }, A, 'up-3', 'mcp'))
  assert.equal(again.replayed, true)
  assert.deepEqual(patchRowKeyed(row, uid, { Email: 'b@x.io' }, A, 'up-4', 'mcp'), { fail: 'not_found' })
})

ok('one-row update: cells over the stored limit are left out of the replay, which says so', () => {
  const [r] = okOf(appendRows(A, uid, [{ Name: 'Big' }])).rows
  const big = 'x'.repeat(IDEMPOTENT_WRITE_ROW_BYTES + 10)
  const first = done(patchRowKeyed(r.id, uid, { Big: big }, A, 'up-big', 'mcp'))
  assert.equal((first.ok.data as Record<string, string>).Big, big, 'the first answer has every cell')
  assert.ok(entry('up-big')!.result_json.length < 2048, 'the stored answer is small')
  const again = done(patchRowKeyed(r.id, uid, { Big: big }, A, 'up-big', 'mcp'))
  assert.equal(again.ok.data, undefined)
  assert.equal(again.ok.data_left_out, true)
  assert.equal(again.ok.id, r.id)
})

ok('many rows: the updates in another order are the same call; other values are refused', () => {
  const rows = okOf(appendRows(A, uid, [{ Name: 'p' }, { Name: 'q' }])).rows
  const ups = rows.map(r => ({ rowId: r.id, cells: { Email: `${r.id}@x.io` } }))
  const first = done(batchUpdateKeyed(A, uid, ups, 'bt-1', 'mcp'))
  assert.deepEqual(first, { ok: { updated: 2 }, replayed: false })
  const again = done(batchUpdateKeyed(A, uid, [...ups].reverse(), 'bt-1', 'rest'))
  assert.deepEqual(again, { ok: { updated: 2 }, replayed: true })
  assert.deepEqual(batchUpdateKeyed(A, uid, [{ ...ups[0], cells: { Email: 'z' } }, ups[1]], 'bt-1', 'mcp'),
    { fail: 'idempotency_conflict' })
  assert.deepEqual(batchUpdateKeyed(A, uid, [ups[0], ups[0]], 'bt-2', 'mcp'), { fail: 'duplicate_rows' })
})

ok('one namespace: a key an append used is refused for an update, and for a run start', () => {
  assert.deepEqual(batchUpdateKeyed(A, uid, [{ rowId: firstRows[0].id, cells: { Name: 'n' } }], 'ap-1', 'mcp'),
    { fail: 'idempotency_conflict' })
  assert.deepEqual(readRunLedger(uid, 'ap-1', 'some-run-hash'), { conflict: true })
})

ok('an append of 1,000 rows is stored compactly (ids, first index, positions not kept)', () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({ Name: `n${i}` }))
  const first = done(appendRowsKeyed(B, uid, many, 'ap-big', 'mcp'))
  const bytes = Buffer.byteLength(entry('ap-big')!.result_json)
  assert.ok(bytes < 45_000, `stored ${bytes} bytes`)
  const again = done(appendRowsKeyed(B, uid, many, 'ap-big', 'mcp'))
  assert.deepEqual(again.ok.answer, first.ok.answer)
})

const age = (key: string, hours: number) => db.prepare(`UPDATE data_operation_ledger
  SET created_at = datetime('now', ?) WHERE idempotency_key = ?`).run(`-${hours} hours`, key)

ok('a key lasts a day: past that the same call writes again', () => {
  age('ap-1', 23)
  assert.equal(done(appendRowsKeyed(A, uid, [{ Name: 'Ann', Email: 'a@x.io' }, { Name: 'Bo' }], 'ap-1', 'mcp'))
    .replayed, true)
  age('ap-1', 25)
  const before = count(A)
  const fresh = done(appendRowsKeyed(A, uid, [{ Name: 'Ann', Email: 'a@x.io' }, { Name: 'Bo' }], 'ap-1', 'mcp'))
  assert.equal(fresh.replayed, false)
  assert.equal(count(A), before + 2)
})

ok('the sweep deletes row-write keys over a day old, never a run\'s', () => {
  writeRunLedger(uid, 'run-old', 'h', 'ai_run', { run_id: 'r1' })
  age('run-old', 48)
  age('bt-1', 30)
  assert.ok(pruneWriteKeys() >= 1)
  assert.equal(entry('bt-1'), undefined)
  assert.ok(entry('run-old'), 'run keys keep their own rule')
  assert.ok(entry('up-1'))
})

ok('row-write keys past the cap go oldest first; a run key isn\'t one of them', () => {
  const insert = db.prepare(`INSERT INTO data_operation_ledger (id, user_id, idempotency_key, operation_kind,
    request_hash, result_json, created_at) VALUES (?, ?, ?, 'cells_update_batch', 'h', '{}', datetime('now', ?))`)
  db.transaction(() => {
    for (let i = 0; i < IDEMPOTENT_WRITE_KEYS_MAX; i++) insert.run(uuid(), uid, `filler-${i}`, `-${i % 3600} seconds`)
  })()
  age('filler-0', 20)
  done(batchUpdateKeyed(A, uid, [{ rowId: firstRows[0].id, cells: { Name: 'cap' } }], 'cap-1', 'mcp'))
  assert.equal(entry('filler-0'), undefined, 'the oldest row-write key went')
  assert.ok(entry('cap-1'))
  assert.ok(entry('run-old'), 'a run key is never pruned by row writes')
})

ok('run and transfer keys keep their 1,000 window: row-write keys don\'t count in it', () => {
  // Their prune drops the 25 keys just past the newest 1,000. With 1,010 newer row-write keys a run key
  // made two hours ago sits in that slice if they counted; they don't, so it stays.
  const prunes: Array<(user: string) => void> = [
    user => writeRunLedger(user, 'run-new', 'h', 'ai_run', { run_id: 'r2' }),
    user => writeTransferLedger(user, 'transfer-new', 'h', { matched: 0, copied: 0, moved: 0 }),
  ]
  for (const prune of prunes) {
    const user = uuid()
    db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(user, 'x')
    const insert = db.prepare(`INSERT INTO data_operation_ledger (id, user_id, idempotency_key, operation_kind,
      request_hash, result_json, created_at) VALUES (?, ?, ?, ?, 'h', '{}', datetime('now', ?))`)
    db.transaction(() => {
      for (let i = 0; i < 1010; i++) insert.run(uuid(), user, `w-${i}`, 'rows_append', '-1 minutes')
      insert.run(uuid(), user, 'run-mid', 'ai_run', '-2 hours')
      for (let i = 0; i < 30; i++) insert.run(uuid(), user, `old-${i}`, 'rows_append', '-3 hours')
    })()
    prune(user)
    assert.ok(db.prepare(`SELECT 1 FROM data_operation_ledger WHERE user_id = ? AND idempotency_key = 'run-mid'`)
      .get(user), 'the run key stays')
  }
})

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall idempotent write checks passed')
