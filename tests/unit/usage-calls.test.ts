// A call without a sheet in the usage history (services/usage.ts, usage-csv.ts; GET /api/v1/usage and MCP
// get_usage): a setup or enrichment call runs on a hidden working table (call_sheets, migration 075), and what it
// spent reads as a call's, with no sheet, as Settings' spend card says it, while its working table is kept and
// after it is removed. By column every call adds up in one line; by run each run is a call's and keeps its column;
// the CSV says "A call without a sheet". A sheet of the user's own, and a deleted one, read as before.
import { v4 as uuid } from 'uuid'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}
const near = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-9
type Row = Record<string, unknown>

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { readUsage, usageAsk } = await import('../../server/src/services/usage')
const { writeUsageCsv } = await import('../../server/src/services/usage-csv')
runMigrations()

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const sheet = (name: string, hidden: boolean) => {
  const tid = uuid(), sid = uuid()
  db.prepare('INSERT INTO tables (id, user_id, name, hidden) VALUES (?,?,?,?)').run(tid, uid, name, hidden ? 1 : 0)
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name) VALUES (?,?,?,?)').run(sid, tid, uid, name)
  if (hidden) db.prepare('INSERT INTO call_sheets (sheet_id, user_id) VALUES (?,?)').run(sid, uid)
  return sid
}
const aiRun = (sid: string, column: string, cost: number, at: string) => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, created_at)
    VALUES (?,?,?,?,'p','m','completed',?)`).run(id, sid, uid, column, at)
  db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, cost_usd)
    VALUES (?,?,?,0,'x','completed',?)`).run(uuid(), id, uid, cost)
  return id
}
const httpRun = (sid: string, column: string, at: string) => {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, created_at)
    VALUES (?,?,?,?,'completed',?,?)`).run(id, sid, uid, JSON.stringify({ requestConfig: { url: 'x' } }), column, at)
  return id
}

const leads = sheet('Leads', false), gone = sheet('Old', false)
const kept = sheet('Setup call a', true), removed = sheet('Setup call b', true)
const own = aiRun(leads, 'Summary', 0.01, '2026-10-05 10:00:00')
aiRun(gone, 'Notes', 0.004, '2026-10-05 11:00:00')
const c1 = aiRun(kept, 'Score', 0.02, '2026-10-06 10:00:00')
const c2 = aiRun(removed, 'Score', 0.03, '2026-10-07 10:00:00')
const c3 = httpRun(removed, 'Lookup', '2026-10-07 11:00:00')
// A working table removed after its results were kept (setup-call.ts removeWorkingTable purges it).
db.prepare('DELETE FROM sheets WHERE id IN (?, ?)').run(removed, gone)

const ask = (groupBy: string) => {
  const out = usageAsk(uid, null, { from: '2026-10-01', to: '2026-10-31', group_by: groupBy })
  if ('fail' in out) throw new Error(out.message)
  return { report: readUsage(out.ok.scope, out.ok.query), ok: out.ok }
}

const byColumn = ask('column').report
const callLine = byColumn.rows.find(r => (r as Row).call) as Row | undefined
check('by column: every call adds up in one line, with no sheet or column', !!callLine
  && callLine.sheet_id === null && callLine.sheet_name === null && callLine.sheet_deleted === false
  && callLine.column === null && callLine.column_deleted === false && callLine.runs === 3
  && near(callLine.ai_cost_usd, 0.05) && callLine.kind === 'mixed', callLine)
check('by column: no call shows as a sheet, kept or deleted', byColumn.rows.every(r => {
  const row = r as Row
  return row.call === true || row.sheet_id === leads || row.sheet_id === gone
}), byColumn.rows)
const lines = byColumn.rows.map(r => r as Row)
check('by column: a sheet of the user\'s own and a deleted one read as before',
  lines.some(r => r.sheet_name === 'Leads' && r.column === 'Summary' && r.sheet_deleted === false && !('call' in r))
  && lines.some(r => r.sheet_id === gone && r.sheet_deleted === true && r.sheet_name === null && !('call' in r)))
check('by column: rows_total counts the call line once', byColumn.rows_total === 3 && byColumn.rows.length === 3,
  byColumn.rows_total)
check('totals are unchanged', byColumn.totals.runs === 5 && near(byColumn.totals.ai_cost_usd, 0.064))

const byRun = ask('run').report.rows.map(r => r as Row)
const runOf = (id: string) => byRun.find(r => r.run_id === id)!
check('by run: each call\'s run is a call\'s, with no sheet, and keeps its column', [c1, c2, c3].every(id => {
  const r = runOf(id)
  return r.call === true && r.sheet_id === null && r.sheet_name === null && r.sheet_deleted === false
}) && runOf(c1).column === 'Score' && runOf(c3).column === 'Lookup', byRun)
check('by run: a sheet\'s run reads as before', runOf(own).sheet_name === 'Leads' && !('call' in runOf(own)))

const csvOf = async (groupBy: string) => {
  let body = ''
  const res = {
    destroyed: false, setHeader: () => {}, write: (c: string) => { body += c; return true }, end: () => {},
    once: () => {}, off: () => {},
  }
  const { ok } = ask(groupBy)
  await writeUsageCsv(res as never, ok.scope, ok.query.groupBy, ok.name)
  return body.split('\r\n')
}
for (const groupBy of ['column', 'run']) {
  const csv = await csvOf(groupBy)
  check(`the ${groupBy} CSV says "A call without a sheet" for calls, and "Deleted sheet" only for the deleted one`,
    csv.filter(l => l.includes('A call without a sheet')).length === (groupBy === 'column' ? 1 : 3)
    && csv.filter(l => l.includes('Deleted sheet')).length === 1, csv)
}

// The call sweep keeps call_sheets past every spend window: the usage history has none.
const { sweepSetupCalls } = await import('../../server/src/services/setup-call')
db.prepare("UPDATE call_sheets SET created_at = datetime('now', '-400 days')").run()
await sweepSetupCalls()
const later = ask('run').report.rows.map(r => r as Row).find(r => r.run_id === c2)
check('a removed call\'s run still reads as a call\'s after the sweep, however old', later?.call === true
  && later.sheet_id === null && later.sheet_deleted === false, later)

// A test copy's run next to the calls: under its sheet, marked, while the calls keep their one line.
const copy = sheet('Leads test', false)
db.prepare('INSERT INTO test_copies (copy_id, sheet_id, user_id) VALUES (?,?,?)').run(copy, leads, uid)
aiRun(copy, 'Summary', 0.02, '2026-10-08 10:00:00')
const mixed = ask('column').report.rows.map(r => r as Row)
const onCopy = mixed.find(r => r.on_test_copy === true)
const calls = mixed.filter(r => r.call === true)
check('a test copy\'s run counts under its sheet, the calls still in one line', onCopy?.sheet_id === leads
  && onCopy.column === 'Summary' && !('call' in onCopy) && calls.length === 1 && calls[0].on_test_copy === false
  && calls[0].runs === 3, mixed)

if (failures > 0) { console.error(`${failures} usage-calls check(s) failed`); process.exit(1) }
console.log('usage-calls: all assertions passed')
passed()
