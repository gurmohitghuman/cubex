// Run schedules (services/run-schedule-store.ts, run-schedule-fire.ts) on a migrated throwaway DB. The sheet has an
// HTTP API column "Ping" whose rows are all filled, so a firing on its empty rows is a column run with nothing to do
// (it ends at once, no request is sent).
//   - the fields are checked (target, rows, cadence, time zone, columns, max_cost_usd), and the cap per sheet;
//   - created: next_at is the next time in its zone; the sheet's run columns are found;
//   - due: the sweep fires it once (a second sweep finds nothing), keeps the column run's id, moves next_at on from
//     now; a firing missed for days fires once;
//   - paused: not fired; resumed: next_at from now, not at once;
//   - a firing that can't start (a column gone, a revoked token, the sheet in the trash)
//     keeps why in last_error and the schedule goes on;
//   - a table's schedule fires on each of its sheets that has the columns; fire now; delete.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const store = await import('../../server/src/services/run-schedule-store')
const fireMod = await import('../../server/src/services/run-schedule-fire')
const { runAs } = await import('../../server/src/lib/actor')
runMigrations()
console.warn = () => {}

let failures = 0
async function check(label: string, fn: () => unknown) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
function sheet(name: string, withPing: boolean): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order,position) VALUES (?,?,?,?,?,?)')
    .run(sid, tid, uid, name, JSON.stringify(withPing ? ['Name', 'Ping'] : ['Name']), name === 'A' ? 0 : 1)
  for (let i = 0; i < 3; i++) {
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(uuid(), sid, uid, i,
      JSON.stringify(withPing ? { Name: `P${i}`, Ping: '200' } : { Name: `P${i}` }))
  }
  if (withPing) {
    db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,total_rows)
      VALUES (?,?,?,?,'completed','Ping',3)`).run(uuid(), sid, uid, JSON.stringify({
      requestConfig: { url: 'https://example.com/ping?q={{Name}}', method: 'GET', headers: {} }, responseMapping: [],
      previewSize: 5 }))
  }
  return sid
}
const sid = sheet('A', true)
const other = sheet('B', false)
const ok = <T>(out: { ok: T } | { fail: string; message: string }): T => {
  if ('fail' in out) throw new Error(out.message)
  return out.ok
}
const caller = { hasSecretsScope: false }
const daily = { sheet_id: sid, rows: 'empty', cadence: 'daily', at_time: '09:00', time_zone: 'UTC' }
const row = (id: string) => db.prepare('SELECT * FROM run_schedules WHERE id = ?').get(id) as Record<string, any>
const due = (id: string, ago = '-1 minutes') =>
  db.prepare("UPDATE run_schedules SET next_at = datetime('now', ?) WHERE id = ?").run(ago, id)

await check('the fields are checked', () => {
  const refused = (f: Record<string, unknown>, says: RegExp) => {
    const out = store.createSchedule(uid, f, caller)
    assert.ok('fail' in out && says.test(out.message), JSON.stringify(out))
  }
  refused({ ...daily, sheet_id: undefined }, /Pass sheet_id, or table_id/)
  refused({ ...daily, table_id: tid }, /Pass sheet_id, or table_id/)
  refused({ ...daily, sheet_id: uuid() }, /Sheet not found/)
  refused({ ...daily, rows: 'some' }, /rows must be one of/)
  refused({ ...daily, cadence: 'yearly' }, /cadence must be one of/)
  refused({ ...daily, time_zone: 'Mars/Base' }, /isn't a time zone/)
  refused({ ...daily, columns: [] }, /columns must be 1 to/)
  refused({ ...daily, max_cost_usd: 0 }, /max_cost_usd must be more than/)
})

let id = ''
await check('created: next_at is the next 09:00 UTC; the sheet\'s run columns are found', () => {
  const s = ok(store.createSchedule(uid, daily, caller))
  id = s.id
  const next = Date.parse(s.next_at)
  assert.ok(next > Date.now() && next - Date.now() <= 86_400_000 && s.next_at.endsWith('T09:00:00.000Z'), s.next_at)
  assert.deepEqual(fireMod.sheetRunColumns(sid, uid), ['Ping'])
  assert.equal(s.made_by, 'the app')
})

await check('due: fired once, the column run kept, next_at moved on from now', async () => {
  due(id)
  assert.equal(await fireMod.sweepRunSchedules(), 1)
  assert.equal(await fireMod.sweepRunSchedules(), 0)
  const s = store.scheduleView(row(id) as any)
  assert.equal(s.last_error, null, s.last_error ?? '')
  assert.equal(s.last_run_ids.length, 1)
  assert.ok(db.prepare('SELECT 1 FROM setup_runs WHERE id = ? AND setup_id IS NULL').get(s.last_run_ids[0]))
  assert.ok(Date.parse(s.next_at) > Date.now())
})
await check('a firing missed for days fires once', async () => {
  due(id, '-3 days')
  assert.equal(await fireMod.sweepRunSchedules(), 1)
  assert.ok(Date.parse(store.scheduleView(row(id) as any).next_at) > Date.now())
})
await check('paused: not fired; resumed: next_at from now, not at once', async () => {
  ok(store.pauseSchedule(uid, id, true))
  due(id)
  assert.equal(await fireMod.sweepRunSchedules(), 0)
  const resumed = ok(store.pauseSchedule(uid, id, false))
  assert.ok(Date.parse(resumed.next_at) > Date.now() && !resumed.paused)
})
await check('a column gone: refused, kept in last_error, the schedule goes on', async () => {
  ok(store.changeSchedule(uid, id, { columns: ['Gone'] }))
  due(id)
  await fireMod.sweepRunSchedules()
  const s = store.scheduleView(row(id) as any)
  assert.ok(s.last_error && /Gone/.test(s.last_error), s.last_error ?? '')
  assert.deepEqual(s.last_run_ids, [])
  assert.ok(Date.parse(s.next_at) > Date.now())
  ok(store.changeSchedule(uid, id, { columns: null }))
})
await check('changing the time works next_at out again', () => {
  const s = ok(store.changeSchedule(uid, id, { cadence: 'hours', every_hours: 2 }))
  assert.ok(Math.abs(Date.parse(s.next_at) - Date.now() - 7_200_000) < 5_000, s.next_at)
  assert.equal(s.at_time, null)
})

await check('made by a token: a revoked token\'s schedule doesn\'t fire, and says why', async () => {
  const tok = uuid()
  db.prepare(`INSERT INTO access_tokens (id,user_id,name,token_hash,token_prefix,scopes) VALUES (?,?,?,?,?,?)`)
    .run(tok, uid, 'robot', `h${tok}`, 'cubex_pat_x', 'read,run')
  const s = ok(runAs({ via: 'mcp', tokenName: 'robot', tokenId: tok }, () => store.createSchedule(uid, daily, caller)))
  assert.equal(s.made_by, 'the access token "robot"')
  db.prepare("UPDATE access_tokens SET revoked_at = datetime('now') WHERE id = ?").run(tok)
  due(s.id)
  await fireMod.sweepRunSchedules()
  assert.match(store.scheduleView(row(s.id) as any).last_error ?? '', /revoked/)
  ok(store.deleteSchedule(uid, s.id))
})

await check('a table\'s schedule fires on each sheet that has the columns', async () => {
  const s = ok(store.createSchedule(uid, { ...daily, sheet_id: undefined, table_id: tid }, caller))
  const fired = ok(await fireMod.fireScheduleNow(uid, s.id))
  assert.equal(fired.last_error, null, fired.last_error ?? '')
  assert.equal(fired.last_run_ids.length, 1) // sheet B has no run column
  assert.equal(fired.next_at, s.next_at) // fire now leaves the next time as it was
  assert.deepEqual(store.listSchedules(uid, { sheetId: other }).map(x => x.id), [s.id])
  ok(store.deleteSchedule(uid, s.id))
})

await check('the sheet in the trash: the firing says so', async () => {
  db.prepare('UPDATE sheets SET trash_id = 999 WHERE id = ?').run(sid)
  const s = ok(await fireMod.fireScheduleNow(uid, id))
  assert.match(s.last_error ?? '', /in the trash/)
  db.prepare('UPDATE sheets SET trash_id = NULL WHERE id = ?').run(sid)
})

await check('the cap per sheet, and delete', () => {
  for (let i = store.listSchedules(uid, { sheetId: sid }).length; i < 20; i++) {
    ok(store.createSchedule(uid, daily, caller))
  }
  const over = store.createSchedule(uid, daily, caller)
  assert.ok('fail' in over && over.fail === 'conflict' && /at most 20/.test(over.message))
  assert.deepEqual(ok(store.deleteSchedule(uid, id)), { deleted: id })
  assert.ok('fail' in store.deleteSchedule(uid, id))
})

if (failures > 0) { console.error(`${failures} run-schedules check(s) failed`); process.exit(1) }
console.log('run-schedules: all assertions passed')
process.exit(0)
