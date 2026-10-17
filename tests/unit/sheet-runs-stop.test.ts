// Stopping every run on a sheet against a migrated throwaway DB
// (services/sheet-runs-stop.ts): a paused AI run, a running HTTP API run, an
// auto-run's enrichment batch and a paused setup all stop; another sheet's run
// doesn't. The column whose auto-run batch stopped pauses ('user'); the idle
// auto-run, and one whose pause lifts on its own, stay on and are named (a
// person's pause doesn't count). Runs started in the same second list in the
// order they started. The ⏳ cells clear. A sheet with nothing running says so,
// someone else's sheet is not found, and MCP's cancel_all works while the sheet
// is busy (a run still writing its placeholders holds it). Plus the sentence.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import stopMod from '../../server/src/services/sheet-runs-stop'
import runsMod from '../../server/src/services/sheet-runs'
import wordsMod from '../../server/src/lib/run-stop-words'
import busyMod from '../../server/src/lib/sheet-busy'
import manageMod from '../../server/src/mcp/tools-run-manage'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { stopSheetRuns } = stopMod as typeof import('../../server/src/services/sheet-runs-stop')
const { activeSheetRuns, activeSetupRuns } = runsMod as typeof import('../../server/src/services/sheet-runs')
const { stopWords, namesList } = wordsMod as typeof import('../../server/src/lib/run-stop-words')
const { withSheetBusy, sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { registerRunManageTools } = manageMod as typeof import('../../server/src/mcp/tools-run-manage')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const P = '⏳ Processing...'

const uid = uuid(), other = uuid(), tableId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(other, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
function sheet(columns: string[], rows: Array<Record<string, string>>): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(id, tableId, uid, `S${id.slice(0, 6)}`, JSON.stringify(columns))
  rows.forEach((r, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(uuid(), id, uid, i, JSON.stringify(r)))
  return id
}
const aiRun = (sheetId: string, column: string, status: string) => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status)
    VALUES (?,?,?,?,?,?,?)`).run(id, sheetId, uid, column, 'Say hi to /name', 'm/x', status)
  return id
}
const httpRun = (sheetId: string, master: string | null, status: string, config: unknown, autorunId?: string) => {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, autorun_id)
    VALUES (?,?,?,?,?,?,?)`).run(id, sheetId, uid, JSON.stringify(config), status, master, autorunId ?? null)
  return id
}
const autorun = (sheetId: string, column: string, pausedReason: string | null = null) => {
  const id = uuid()
  db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, paused_reason)
    VALUES (?,?,?,?,?,?)`).run(id, uid, sheetId, column, 'enrichment', pausedReason)
  return id
}
const statusOf = (table: string, id: string) =>
  db.prepare(`SELECT status FROM ${table} WHERE id = ?`).pluck().get(id) as string
const cells = (sheetId: string, col: string) =>
  (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sheetId) as string[])
    .map(d => JSON.parse(d)[col] ?? '')

async function main() {
  const enrichment = { enrichment: { v: 1 }, requestConfig: { method: 'GET', url: 'x' } }
  const s = sheet(['Name', 'Summary', 'Lookup', 'Work email', 'Score'], [
    { Name: 'Ada', Summary: P, Lookup: P, 'Work email': P },
    { Name: 'Alan', Summary: 'done', Lookup: P, 'Work email': '✅ Found' },
  ])
  const ai = aiRun(s, 'Summary', 'paused')
  const http = httpRun(s, 'Lookup', 'running', { requestConfig: { method: 'GET', url: 'x' } })
  const batchEntry = autorun(s, 'Work email')
  autorun(s, 'Score')
  autorun(s, 'Retrying', 'unreachable')
  autorun(s, 'Broken', 'failed')
  const batch = httpRun(s, 'Work email', 'running', enrichment, batchEntry)
  db.prepare(`INSERT INTO setup_runs (id, user_id, sheet_id, setup_name, plan, steps, status) VALUES (?,?,?,?,?,?,?)`)
    .run('setup-1', uid, s, 'Lead chain', JSON.stringify({ spec: { v: 1, inputs: [], keys: [], steps: [] },
      layers: [] }), '[]', 'paused')
  const done = httpRun(s, 'Old', 'completed', {})
  const elsewhere = sheet(['Name', 'Fit'], [{ Name: 'Grace', Fit: P }])
  const otherRun = aiRun(elsewhere, 'Fit', 'running')

  // What's running, as get_sheet lists it.
  const active = activeSheetRuns(s, uid)
  check('active runs: AI, HTTP and the enrichment batch, typed', eq(active.map(r => [r.run_type, r.column, r.status,
    r.auto_run]), [['ai', 'Summary', 'paused', false], ['http', 'Lookup', 'running', false],
    ['enrichment', 'Work email', 'running', true]]), active)
  check('active setups', eq(activeSetupRuns(s, uid), [{ setup_run_id: 'setup-1', setup: 'Lead chain',
    status: 'paused' }]))

  const out = await stopSheetRuns(uid, s)
  if (!('ok' in out)) throw new Error(JSON.stringify(out))
  const r = out.ok
  check('stopped every run', eq(r.stopped_runs.map(x => x.run_id).sort(), [ai, http, batch].sort()), r.stopped_runs)
  check('stopped the setup', eq(r.stopped_setup_runs, [{ setup_run_id: 'setup-1', setup: 'Lead chain' }]))
  check('statuses are cancelled', [['ai_runs', ai], ['http_runs', http], ['http_runs', batch]]
    .every(([t, id]) => statusOf(t, id) === 'cancelled'))
  check('the setup is cancelled', statusOf('setup_runs', 'setup-1') === 'cancelled')
  check('a finished run stays finished', statusOf('http_runs', done) === 'completed')
  check("another sheet's run goes on", statusOf('ai_runs', otherRun) === 'running')
  check('the stopped batch paused its auto-run', eq(r.auto_run_paused, ['Work email']), r.auto_run_paused)
  check("that auto-run's pause is a person's",
    db.prepare('SELECT paused_reason FROM autorun_columns WHERE id = ?').pluck().get(batchEntry) === 'user')
  check('the idle auto-run and one that retries on its own are still on; a person\'s pause is not',
    eq(r.auto_run_on, ['Retrying', 'Score']), r.auto_run_on)
  check('message', r.message === 'Stopped 3 runs: "Summary", "Lookup" and "Work email". Stopped the setup '
    + '"Lead chain". Calls already sent finish, and paid ones are still billed. Auto-run on "Work email" is paused '
    + 'until you resume it. Auto-run is still on for "Retrying" and "Score", so new rows will start runs there again.',
    r.message)
  check('nothing active any more', activeSheetRuns(s, uid).length === 0 && activeSetupRuns(s, uid).length === 0)
  await sleep(300)
  check('⏳ cells cleared, results kept', eq(cells(s, 'Summary'), ['', 'done']) && eq(cells(s, 'Lookup'), ['', ''])
    && eq(cells(s, 'Work email'), ['', '✅ Found']), [cells(s, 'Summary'), cells(s, 'Lookup'), cells(s, 'Work email')])
  check("another sheet's cells stay", eq(cells(elsewhere, 'Fit'), [P]))

  const again = await stopSheetRuns(uid, s)
  check('nothing left: says so, and names the auto-runs still on', 'ok' in again && again.ok.message
    === 'Nothing was running on this sheet. Auto-run is still on for "Retrying" and "Score", so new rows will start '
    + 'runs there again.' && again.ok.stopped_runs.length === 0, again)
  const notMine = await stopSheetRuns(other, s)
  check("someone else's sheet is not found", 'fail' in notMine && notMine.fail === 'not_found')
  check('their run was not touched', statusOf('ai_runs', otherRun) === 'running')

  // An HTTP run with no main column is named by its first output column.
  const bare = sheet(['Title'], [{ Title: P }])
  const bareRun = httpRun(bare, null, 'pending', {})
  db.prepare(`INSERT INTO http_column_associations (id, sheet_id, user_id, extracted_column_name, run_id)
    VALUES (?,?,?,?,?)`).run(uuid(), bare, uid, 'Title', bareRun)
  check('no main column: its output column', activeSheetRuns(bare, uid)[0]?.column === 'Title')

  // Runs started in the same second list in the order they started.
  const same = sheet(['Name'], [{ Name: 'x' }])
  const order = ['B', 'A', 'D', 'C'].map(c => httpRun(same, c, 'running', {}))
  db.prepare("UPDATE http_runs SET created_at = '2026-10-17 10:00:00' WHERE sheet_id = ?").run(same)
  check('same second: in the order they started', eq(activeSheetRuns(same, uid).map(r => r.run_id), order))

  // MCP control_run cancel_all on a sheet busy with a run's placeholders.
  const tools: Record<string, (args: unknown, extra: unknown) => Promise<any>> = {}
  registerRunManageTools({ registerTool: (name: string, _c: unknown, h: any) => { tools[name] = h } } as any,
    { userId: uid, tokenId: 't', tokenName: 't', scopes: new Set(['read', 'run']) } as any)
  const busySheet = sheet(['Name', 'Fit'], [{ Name: 'Kenji', Fit: P }])
  const seeding = aiRun(busySheet, 'Fit', 'pending')
  const held = await withSheetBusy(busySheet, 'starting a run', async () => {
    const res = await tools.control_run({ action: 'cancel_all', sheet_id: busySheet }, {})
    return { busy: sheetBusyWith(busySheet), res }
  })
  if ('busy' in held && typeof held.busy === 'string' && !('res' in held)) throw new Error(held.busy)
  const busyOut = (held as { busy: string | null; res: any })
  const body = JSON.parse(busyOut.res.content[0].text)
  check('cancel_all on a busy sheet: the sheet was busy', busyOut.busy === 'starting a run')
  check('cancel_all on a busy sheet: stopped, not refused', !busyOut.res.isError
    && eq(body.stopped_runs.map((x: any) => x.run_id), [seeding]) && statusOf('ai_runs', seeding) === 'cancelled', body)
  const noSheet = await tools.control_run({ action: 'cancel_all' }, {})
  check('cancel_all without sheet_id says so', noSheet.isError && /needs sheet_id/.test(noSheet.content[0].text))

  // The sentence.
  check('names list', namesList(['A']) === '"A"' && namesList(['A', 'B']) === '"A" and "B"'
    && namesList(['A', 'B', 'C']) === '"A", "B" and "C"' && namesList(['A', 'A']) === '"A"')
  check('names list: the first five and how many more',
    namesList(['1', '2', '3', '4', '5', '6', '7']) === '"1", "2", "3", "4", "5" and 2 more')
  check('one run, fills going on', stopWords({ runs: ['X'], setups: [], paused: [], autoOn: [], filling: ['Clean'] })
    === 'Stopped 1 run: "X". Calls already sent finish, and paid ones are still billed. Still filling for free and '
    + 'finishing on their own: "Clean".')
  check('setups only', stopWords({ runs: [], setups: ['A', 'B'], paused: [], autoOn: [], filling: [] })
    === 'Stopped the setups "A" and "B".')
  check('no em dash in any sentence', !r.message.includes(String.fromCharCode(0x2014)))

  if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
  console.log('sheet-runs-stop: all passed')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
