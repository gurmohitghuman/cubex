// Over 200 lines: one call's life, from its items to its removal and its spend, on one setup; then pages and files.
// A saved setup called on items without a sheet (services/setup-call.ts), on a migrated throwaway DB, with a free
// chain of two clean columns: the items checked (count, unknown inputs, cell types); an estimate starts nothing
// and leaves no working table; a call runs on a hidden working table that no list or count shows, finishes with
// each item's status and outputs in the order sent (Cubex's words in a cell never an output), and its id is the
// setup run's; a start takes a run-start slot; Settings' spend card shows what a call spent as "a call without a
// sheet", before and after its working table goes; the sweep stops a call paused longer than the keep time (its
// results then kept as a finished call's) and removes the working table once the results have been kept long
// enough (and an orphan one), and the call is then not found.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import libMod from '../../server/src/services/setup-library'
import callMod from '../../server/src/services/setup-call'
import readMod from '../../server/src/services/workspace-read'
import overviewMod from '../../server/src/services/workspace-overview'
import trashMod from '../../server/src/services/trash-read'
import runSharedMod from '../../server/src/services/run-shared'
import spendMod from '../../server/src/services/enrich-spend'
import constMod from '../../server/src/lib/constants'
import type { SetupSpec } from '../../server/src/lib/setups/spec'
import { passed } from './ends-on-its-own'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { insertSetup } = libMod as typeof import('../../server/src/services/setup-library')
const { callSetup, getSetupCall, sweepSetupCalls, STALE_PAUSE } =
  callMod as typeof import('../../server/src/services/setup-call')
const { enrichSpend } = spendMod as typeof import('../../server/src/services/enrich-spend')
const { ENRICH_SPEND_TOP_COLUMNS } = constMod as typeof import('../../server/src/lib/constants')
const { listTablesWithSheets } = readMod as typeof import('../../server/src/services/workspace-read')
const { workspaceOverview } = overviewMod as typeof import('../../server/src/services/workspace-overview')
const { listTrash } = trashMod as typeof import('../../server/src/services/trash-read')
const { takeRunStart } = runSharedMod as typeof import('../../server/src/services/run-shared')
const { setupSweep } = await import('../../server/src/services/setup-sweep')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const spec: SetupSpec = { v: 1, inputs: ['Name'], keys: [], steps: [
  { kind: 'clean', name: 'Trimmed', source: 'Name', cleaner: 'trim', options: {}, autoRun: false },
  { kind: 'clean', name: 'Lower', source: 'Trimmed', cleaner: 'lowercase', options: {}, autoRun: false },
] }
const setup = insertSetup(uid, 'Trim then lower', null, spec)
if (!('ok' in setup)) throw new Error(JSON.stringify(setup))
const setupId = setup.ok.id
const caller = { hasSecretsScope: true }
const hiddenTables = () => db.prepare('SELECT COUNT(*) FROM tables WHERE hidden = 1 AND trash_id IS NULL')
  .pluck().get() as number

// The items.
for (const [label, items, says] of [
  ['no items', [], 'items must be an array of 1 to 100'],
  ['101 items', Array.from({ length: 101 }, () => ({ Name: 'x' })), 'items must be an array of 1 to 100'],
  ['not an array', { Name: 'x' }, 'items must be an array'],
  ['an input the setup lacks', [{ Name: 'a' }, { Nmae: 'b' }], 'Item 1 has "Nmae", which isn\'t an input'],
  ['an object as a value', [{ Name: { a: 1 } }], 'Item 0: Value for column "Name" must be a string'],
] as Array<[string, unknown, string]>) {
  const out = await callSetup(uid, setupId, items, { estimateOnly: false }, caller)
  check(`refused: ${label}`, 'fail' in out && out.fail === 'bad_request' && out.message.includes(says), out)
}
const missing = await callSetup(uid, uuid(), [{ Name: 'x' }], { estimateOnly: false }, caller)
check('a setup that isn\'t there: not found', 'fail' in missing && missing.fail === 'not_found', missing)
check('nothing refused left a working table', hiddenTables() === 0, hiddenTables())

// An estimate: priced, a pure read (no working table made, nothing written: setup-call-estimate.test.ts prices
// paid steps).
const counts = () => ['tables', 'sheets', 'rows', 'setup_runs', 'ai_runs', 'http_runs', 'setup_calls', 'call_sheets']
  .map(t => db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get() as number).join()
  + ` ${db.prepare('SELECT total_changes()').pluck().get()}`
const beforeEstimate = counts()
const est = await callSetup(uid, setupId, [{ Name: ' A ' }, { Name: 'B' }], { estimateOnly: true }, caller)
check('an estimate prices the items and makes the setup\'s columns',
  'ok' in est && 'estimate' in est.ok && est.ok.items === 2 && est.ok.makes.join() === 'Trimmed,Lower', est)
check('an estimate makes no table, sheet, row or run and writes nothing', counts() === beforeEstimate,
  { before: beforeEstimate, after: counts() })

// A call.
const items = [{ Name: '  Ada LOVELACE ' }, {}, { Name: 'Grace' }, { Name: 42 }]
const started = await callSetup(uid, setupId, items, { estimateOnly: false }, caller)
if (!('ok' in started) || !('setup_call' in started.ok)) throw new Error(JSON.stringify(started))
const call = started.ok.setup_call
check('a call starts: running, 4 items, no results yet', call.items === 4 && call.results === undefined
  && ['running', 'done'].includes(call.status), call)
check('its id is the setup run\'s', !!db.prepare('SELECT 1 FROM setup_runs WHERE id = ?').get(call.id))
check('its working table is hidden', hiddenTables() === 1, hiddenTables())
check('no list shows the working table', (await listTablesWithSheets(uid)).length === 0
  && workspaceOverview(uid).table_count === 0 && workspaceOverview(uid).active_setup_runs.length === 0)
check('another user can\'t read it', getSetupCall(uuid(), call.id) === null)

let view = getSetupCall(uid, call.id)!
for (let i = 0; i < 200 && view.status === 'running'; i++) {
  await setupSweep()
  await sleep(50)
  view = getSetupCall(uid, call.id)!
}
check('the call finishes done', view.status === 'done', view)
check('each item\'s outputs, in the order sent', JSON.stringify(view.results) === JSON.stringify([
  { item: 0, status: 'done', error: null, outputs: { Trimmed: 'Ada LOVELACE', Lower: 'ada lovelace' } },
  { item: 1, status: 'not_run', error: null, outputs: { Trimmed: null, Lower: null } },
  { item: 2, status: 'done', error: null, outputs: { Trimmed: 'Grace', Lower: 'grace' } },
  { item: 3, status: 'done', error: null, outputs: { Trimmed: '42', Lower: '42' } },
]), view.results)

// Cubex's words in a cell are never an output: the item's status and error say what happened.
const sheetOfCall = db.prepare('SELECT sheet_id FROM setup_calls WHERE id = ?').pluck().get(call.id) as string
const putCells = (index: number, cells: Record<string, string>) => db.prepare(
  'UPDATE rows SET data = json_patch(data, ?) WHERE sheet_id = ? AND row_index = ?',
).run(JSON.stringify(cells), sheetOfCall, index)
putCells(0, { Lower: '❌ Error: Rate limited' })
putCells(1, { Trimmed: '⏭️ Not found' })
putCells(2, { Trimmed: '⏭️ Condition not met' })
const marked = getSetupCall(uid, call.id)!.results!
check('a failed cell: error, naming the column, and no output', marked[0].status === 'error'
  && marked[0].error === 'Lower: Rate limited' && marked[0].outputs.Lower === null
  && marked[0].outputs.Trimmed === 'Ada LOVELACE', marked[0])
check('a step that found nothing: no_result, no output', marked[1].status === 'no_result'
  && marked[1].error === null && marked[1].outputs.Trimmed === null, marked[1])
check('a step its rule kept out: condition_not_met', marked[2].status === 'condition_not_met'
  && marked[2].outputs.Trimmed === null && marked[2].outputs.Lower === 'grace', marked[2])
check('kept until 24 hours after it finished', view.keep_until !== null
  && Math.abs(Date.parse(view.keep_until) - Date.now() - 24 * 3_600_000) < 120_000, view.keep_until)
check('auto-run is never turned on in a working table',
  (db.prepare('SELECT COUNT(*) FROM autorun_columns WHERE enabled = 1').pluck().get() as number) === 0)

// What a call's enrichments spent shows in Settings as one line for calls, not under the working table's name;
// a deleted sheet's spend stays "Deleted sheet".
const ledger = db.prepare(`INSERT INTO enrichment_calls (id, user_id, sheet_id, status_column, tool_id, attempt,
  cost_micro) VALUES (?, ?, ?, ?, 'treg.people.email.find', 't1', ?)`)
ledger.run(uuid(), uid, sheetOfCall, 'Email', 20_000)
ledger.run(uuid(), uid, sheetOfCall, 'Status', 10_000)
ledger.run(uuid(), uid, uuid(), 'Gone', 5_000)
const spendLines = async () => (await enrichSpend(uid, 30)).columns
const callSpend = async () => {
  const lines = await spendLines()
  const call = lines.filter(c => c.call)
  return call.length === 1 && call[0].calls === 2 && Math.abs(call[0].spentUsd - 0.03) < 1e-9
    && call[0].sheetId === null && call[0].tableName === null && call[0].column === null
    && lines.some(c => !c.call && c.sheetId === null && c.column === 'Gone')
}
check('Settings\' spend: a call\'s spend is one line for calls, a deleted sheet\'s stays apart', await callSpend(),
  await spendLines())
// More columns spending more than the calls than the card lists: the calls' line is still listed, after them, and
// "more columns" counts only columns.
const bigger = Array.from({ length: ENRICH_SPEND_TOP_COLUMNS + 1 }, () => uuid())
for (const id of bigger) ledger.run(id, uid, uuid(), 'Bigger', 100_000)
const crowded = await enrichSpend(uid, 30)
check('a call\'s line is listed past the top columns, never as one of the more columns',
  crowded.columns.length === ENRICH_SPEND_TOP_COLUMNS + 1 && crowded.columns.filter(c => c.call).length === 1
  && crowded.columns[ENRICH_SPEND_TOP_COLUMNS].call === true && crowded.otherColumns === 2
  && Math.abs(crowded.otherUsd - 0.105) < 1e-9 && Math.abs(crowded.totalUsd - 2.135) < 1e-9, crowded)
db.prepare('DELETE FROM enrichment_calls WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(bigger))

// A start takes a slot of the token's run-start window (an estimate doesn't): a full window refuses it before
// any working table is made.
const tok = uuid()
while (!('limited' in (takeRunStart(uid, tok) ?? {}))) { /* fill the window */ }
const limited = await callSetup(uid, setupId, [{ Name: 'x' }], { estimateOnly: false }, { ...caller, tokenId: tok })
check('a full run-start window refuses a start', 'fail' in limited && limited.fail === 'rate_limited'
  && !!limited.rate && hiddenTables() === 1, limited)
const pricedOk = await callSetup(uid, setupId, [{ Name: 'x' }], { estimateOnly: true }, { ...caller, tokenId: tok })
check('an estimate still answers with the window full', 'ok' in pricedOk && 'estimate' in pricedOk.ok, pricedOk)

// A call paused (by hand, or at a limit) and never resumed: stopped once it has been paused longer than the keep
// time, its results then kept that long again, as any finished call's.
const second = await callSetup(uid, setupId, [{ Name: ' Paused ' }], { estimateOnly: false }, caller)
if (!('ok' in second) || !('setup_call' in second.ok)) throw new Error(JSON.stringify(second))
const pausedId = second.ok.setup_call.id
for (let i = 0; i < 200 && getSetupCall(uid, pausedId)!.status === 'running'; i++) {
  await setupSweep()
  await sleep(50)
}
const pausedFor = (hours: number) => db.prepare(`UPDATE setup_runs SET status = 'paused', error_message = NULL,
  updated_at = datetime('now', ?) WHERE id = ?`).run(`-${hours} hours`, pausedId)
pausedFor(23)
check('the sweep keeps a call paused for less than the keep time', await sweepSetupCalls() === 0
  && getSetupCall(uid, pausedId)!.status === 'paused' && hiddenTables() === 2)
pausedFor(25)
const stopped = (await sweepSetupCalls(), getSetupCall(uid, pausedId)!)
check('the sweep stops a call paused for longer, and keeps its results', stopped.status === 'cancelled'
  && stopped.error_message === STALE_PAUSE && stopped.results?.[0].outputs.Lower === 'paused' && hiddenTables() === 2
  && stopped.keep_until !== null && Date.parse(stopped.keep_until) - Date.now() > 23 * 3_600_000, stopped)

// The sweep: nothing yet; once the keep time has passed, the working table goes and the call is not found.
check('the sweep keeps a fresh call', await sweepSetupCalls() === 0 && hiddenTables() === 2)
db.prepare("UPDATE setup_runs SET updated_at = datetime('now', '-25 hours') WHERE id IN (?, ?)").run(call.id, pausedId)
check('the sweep removes them after the keep time', await sweepSetupCalls() === 2 && hiddenTables() === 0)
check('the trash never lists it', listTrash(uid).items.length === 0 && listTrash(uid).total_bytes === 0,
  listTrash(uid))
for (let i = 0; i < 100 && db.prepare('SELECT 1 FROM setup_calls WHERE id = ?').get(call.id); i++) await sleep(50)
check('purged: the call is not found', getSetupCall(uid, call.id) === null
  && !db.prepare('SELECT 1 FROM tables WHERE hidden = 1').get())
check('Settings\' spend still names a removed call\'s spend as a call\'s', await callSpend(), await spendLines())
db.prepare("UPDATE call_sheets SET created_at = datetime('now', '-400 days')").run()
db.prepare("UPDATE enrichment_calls SET created_at = datetime('now', '-400 days') WHERE sheet_id = ?").run(sheetOfCall)
await sweepSetupCalls()
check('a removed call\'s sheet is kept past every spend window: the usage history has no window',
  !!db.prepare('SELECT 1 FROM call_sheets WHERE sheet_id = ?').get(sheetOfCall))

// An orphan working table (a restart between the table and the run, or an upload link never used) goes once no
// upload link can still be filling it: kept at 2 hours (a link used at its 15th minute may take 70 minutes to
// bring the largest file at the slowest speed allowed), gone at 3.
const orphan = uuid()
db.prepare(`INSERT INTO tables (id, user_id, name, hidden, created_at)
  VALUES (?, ?, ?, 1, datetime('now', '-2 hours'))`)
  .run(orphan, uid, 'Setup call orphan')
check('the sweep keeps a 2-hour-old orphan: an upload may still be arriving', await sweepSetupCalls() === 0
  && !!db.prepare('SELECT 1 FROM tables WHERE id = ? AND trash_id IS NULL').get(orphan))
db.prepare("UPDATE tables SET created_at = datetime('now', '-3 hours') WHERE id = ?").run(orphan)
check('the sweep removes an orphan working table', await sweepSetupCalls() === 1
  && !db.prepare('SELECT 1 FROM tables WHERE id = ? AND trash_id IS NULL').get(orphan))

// Pages: a finished call's results a page at a time, and the next page's start.
const paged = await callSetup(uid, setupId, Array.from({ length: 5 }, (_, i) => ({ Name: `N${i}` })),
  { estimateOnly: false }, caller)
if (!('ok' in paged) || !('setup_call' in paged.ok)) throw new Error(JSON.stringify(paged))
let pv = getSetupCall(uid, paged.ok.setup_call.id)!
for (let i = 0; i < 200 && pv.status === 'running'; i++) {
  await setupSweep(); await sleep(50); pv = getSetupCall(uid, paged.ok.setup_call.id)!
}
const p1 = getSetupCall(uid, pv.id, { limit: 2 })!
const p3 = getSetupCall(uid, pv.id, { from: 4, limit: 2 })!
check('a page of 2: items 0 and 1, the next from 2', JSON.stringify(p1.results!.map(r => r.item)) === '[0,1]'
  && p1.next_from === 2, p1)
check('the last page: item 4, no next', JSON.stringify(p3.results!.map(r => r.outputs.Lower)) === '["n4"]'
  && p3.next_from === null, p3)

// A file call: needs a ceiling, starts once its rows are in, and an empty file starts nothing.
const { prepareFileCall, startFileCall } = await import('../../server/src/services/setup-call-file')
const { appendRows } = await import('../../server/src/services/rows-write')
const noCeiling = prepareFileCall(uid, setupId, { estimateOnly: false }, caller)
check('a file call without max_cost_usd is refused', 'fail' in noCeiling && noCeiling.message.includes('max_cost_usd'))
const tablesBefore = hiddenTables()
const fullFile = prepareFileCall(uid, setupId, { estimateOnly: false, maxCostUsd: 1 }, { ...caller, tokenId: tok })
check('a full run-start window refuses a file call before its table is made', 'fail' in fullFile
  && fullFile.fail === 'rate_limited' && hiddenTables() === tablesBefore, fullFile)
const prepared = prepareFileCall(uid, setupId, { estimateOnly: false, maxCostUsd: 1 }, caller)
if ('fail' in prepared) throw new Error(JSON.stringify(prepared))
check('its working table is made, hidden, with the setup\'s inputs', hiddenTables() === tablesBefore + 1
  && JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(prepared.sheetId) as string)
    .join() === 'Name')
const empty = await startFileCall(uid, prepared.sheetId, prepared.call)
check('a file with no rows starts nothing and its table goes', 'fail' in empty && hiddenTables() === tablesBefore,
  empty)
const again = prepareFileCall(uid, setupId, { estimateOnly: false, maxCostUsd: 1 }, caller)
if ('fail' in again) throw new Error(JSON.stringify(again))
appendRows(again.sheetId, uid, [{ Name: ' One ' }, { Name: 'Two' }])
const fileCall = await startFileCall(uid, again.sheetId, again.call)
check('a file call starts with its rows as items', 'ok' in fileCall && 'setup_call' in fileCall.ok
  && fileCall.ok.setup_call.items === 2, fileCall)

if (failures > 0) { console.error(`${failures} setup-call check(s) failed`); process.exit(1) }
console.log('setup-call: all assertions passed')
passed()
