// Over 200 lines: one mock treg and one working-table estimate to compare with, shared by every case.
// An enrichment call's estimate (services/enrich-call-estimate.ts), on a migrated throwaway DB with treg served by
// the repo's mock (tests/mock-treg, started here and stopped by its PID) and one tool with no known price beside it:
//   - it is a pure read: every table's row count and SQLite's change count stay as they were, for an estimate and
//     for a start refused up front (max_cost_usd, no known price, today's limit, the treg balance, the token's cap);
//   - its numbers are the estimate on a working table holding the same items (what call_enrichment's estimate gave
//     when it made one): a waterfall and a single tool, items missing an input or empty, items that reuse a found
//     answer for the same inputs, a "status" field, a tool with no known price, today's limit and the treg balance.
import fs from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const tregPort = await new Promise<number>(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as AddressInfo).port
    s.close(() => resolve(p))
  })
})
const treg = spawn(process.execPath, ['tests/mock-treg/server.mjs', String(tregPort)], { stdio: 'ignore' })
process.on('exit', () => treg.kill())
const TREG = `http://127.0.0.1:${tregPort}`
for (;;) {
  try { if ((await fetch(`${TREG}/health`)).ok) break } catch { /* not up yet */ }
  await sleep(50)
}
process.env.TREG_BASE_URL = TREG
const mockState = (s: Record<string, unknown>) => fetch(`${TREG}/__mock/state`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s),
})

// A tool with no known price (it runs on the team's own provider key): an email check with its price left out.
const OWN = 'testown.people.email.verify'
const verify = 'tests/mock-treg/fixtures/catalog/endpoints/millionverifier.people.email.verify.json'
const own = JSON.parse(fs.readFileSync(verify, 'utf8')) as { endpoint: Record<string, unknown> }
own.endpoint = { ...own.endpoint, id: OWN, cost: { type: 'per_call', unit: 'call' } }
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
  (String(url) === `${TREG}/catalog/endpoints/${OWN}`
    ? new Response(JSON.stringify(own), { status: 200, headers: { 'content-type': 'application/json' } })
    : realFetch(url, init))) as typeof fetch

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { callEnrichment, callColumns } = await import('../../server/src/services/enrich-call')
const { tokenStartEnrichmentRun, agentEnrichInput } = await import('../../server/src/services/enrich-token-run')
const { prepareEnrichmentStart } = await import('../../server/src/services/enrich-run-prepare')
const { rowRequest } = await import('../../server/src/services/enrich-row')
const { reuseKeyOf } = await import('../../server/src/lib/enrich-reuse-key')
const { getTool } = await import('../../server/src/services/enrich-catalog')
const { itemsOf, removeWorkingTable } = await import('../../server/src/services/setup-call')
const { createTable } = await import('../../server/src/services/table-crud')
const { addSheetColumn } = await import('../../server/src/services/column-add')
const { appendRows } = await import('../../server/src/services/rows-write')
const { saveTregToken, setDailyLimitMicro } = await import('../../server/src/services/treg-key')
runMigrations()
console.warn = () => {}

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
saveTregToken(uid, 'treg_mock_team_key')
const token = (capUsd: number | null) => {
  const id = uuid()
  db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes, spend_cap_micro)
    VALUES (?,?,?,?,?,?,?)`).run(id, uid, `Agent ${id.slice(0, 6)}`, `h-${id}`, 'cubex_pat_x', 'read,run',
    capUsd === null ? null : Math.round(capUsd * 1e6))
  return { userId: uid, tokenId: id, scopes: new Set(['read', 'run']) }
}
const caller = token(null)

// Every table's row count, and every change made on this connection since it opened.
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  ORDER BY name`).pluck().all() as string[]
const snapshot = () => ({
  ...Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT COUNT(*) FROM "${t}"`).pluck().get() as number])),
  changes: db.prepare('SELECT total_changes()').pluck().get() as number,
})

type Item = Record<string, string>
// The working table a call makes for these items (its columns, the items as its rows) and run_enrichment's arguments.
async function tableFor(toolId: string, raw: Item[], fields?: string[], hidden = true) {
  const found = await getTool(toolId)
  if (!('ok' in found)) throw new Error(JSON.stringify(found))
  const inputNames = found.ok.inputs.map(i => i.name)
  const items = itemsOf(raw, inputNames, 1000, 'tool')
  if (typeof items === 'string') throw new Error(items)
  const keep = fields ?? found.ok.outputs.map(o => o.field)
  const used = inputNames.filter(n => items.some(it => n in it))
  const cols = callColumns(used, keep)
  const t = createTable(uid, `Same items ${uuid()}`, { hidden })
  if (!('ok' in t)) throw new Error(JSON.stringify(t))
  for (const name of cols.input.values()) addSheetColumn(t.ok.sheetId, uid, name, { seedEmptyRow: false })
  appendRows(t.ok.sheetId, uid, items.map(it =>
    Object.fromEntries(Object.entries(it).map(([k, v]) => [cols.input.get(k) ?? k, v]))))
  const args = {
    sheet_id: t.ok.sheetId, tool_id: toolId, column_name: cols.status,
    inputs: Object.fromEntries(used.map(n => [n, cols.input.get(n)!])),
    outputs: keep.map(f => ({ field: f, column_name: f })),
  }
  return { tool: found.ok, tableId: t.ok.id, sheetId: t.ok.sheetId, args }
}

// The estimate as call_enrichment made it before: on a hidden working table holding the items, then removed.
async function onATable(toolId: string, items: Item[], fields?: string[]) {
  const t = await tableFor(toolId, items, fields)
  const out = await tokenStartEnrichmentRun(caller, { ...t.args, estimate_only: true })
  removeWorkingTable(uid, t.tableId)
  // Its purge goes on in the background: done before the next snapshot.
  while ((db.prepare('SELECT COUNT(*) FROM trash_items').pluck().get() as number) > 0) await sleep(20)
  if (!('ok' in out)) return out
  const { status_column: _s, ...estimate } = out.ok as Record<string, unknown>
  return estimate
}

// Found answers an earlier run of this tool holds for these items (by their place in the list), on a sheet of its own.
async function answersFor(toolId: string, items: Item[], which: number[], fields?: string[]) {
  const t = await tableFor(toolId, items, fields, false)
  const input = agentEnrichInput(t.args, t.tool, null, null)
  if ('fail' in input) throw new Error(input.message)
  const prepared = await prepareEnrichmentStart(uid, t.sheetId, input.ok)
  if ('fail' in prepared) throw new Error(prepared.message)
  const { config, columns } = prepared.ok
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status) VALUES (?, ?, ?, '{}', 'completed')`)
    .run(runId, t.sheetId, uid)
  const rows = db.prepare('SELECT row_index, data FROM rows WHERE sheet_id = ? ORDER BY row_index').all(t.sheetId) as
    Array<{ row_index: number; data: string }>
  for (const k of which) {
    const req = rowRequest(config, { rowIndex: k, rowId: null, data: JSON.parse(rows[k].data) }, columns)
    if (!('built' in req)) throw new Error(`item ${k} sends no request`)
    db.prepare(`INSERT INTO http_results (id, run_id, user_id, row_index, response_data, status, reuse_key, answered_at)
      VALUES (?, ?, ?, ?, '{"output":{"email":"x@acme.example"}}', 'completed', ?, datetime('now'))`)
      .run(uuid(), runId, uid, k, reuseKeyOf(config, req.built))
  }
}

type Estimate = {
  rows_to_process: number; price_known: boolean; reuse: { rows: number };
  estimated_cost_usd: { low: number; high: number } | null; may_pass_daily_limit: boolean; may_pass_balance?: boolean;
}
// The call's estimate: written nothing, and the same as on a working table.
async function same(label: string, toolId: string, items: Item[], fields?: string[]): Promise<Estimate | null> {
  const before = snapshot()
  const out = await callEnrichment(caller, { toolId, items, fields, estimateOnly: true })
  const after = snapshot()
  check(`${label}: the estimate writes nothing`, JSON.stringify(before) === JSON.stringify(after), { before, after })
  if (!('ok' in out) || !('estimate' in out.ok)) { check(`${label}: priced`, false, out); return null }
  const old = await onATable(toolId, items, fields)
  check(`${label}: the same estimate as on a working table`, JSON.stringify(out.ok.estimate) === JSON.stringify(old),
    { call: out.ok.estimate, table: old })
  return out.ok.estimate as unknown as Estimate
}

// A start refused up front: says why, with the estimate, and writes nothing (no working table made and dropped).
async function refused(label: string, says: RegExp, input: Record<string, unknown>, c = caller) {
  const before = snapshot()
  const out = await callEnrichment(c, { toolId: FIND, items: people, estimateOnly: false, ...input })
  const after = snapshot()
  check(`refused up front: ${label}, writing nothing`, 'fail' in out && out.fail === 'over_ceiling'
    && says.test(out.message) && !!out.estimate && JSON.stringify(before) === JSON.stringify(after),
  { out, before, after })
}

const FIND = 'treg.people.email.find'
const people = [
  { full_name: 'Ada Lovelace', domain: 'acme.example' }, { full_name: 'Grace Hopper', domain: 'navy.example' },
  { full_name: 'Katherine Johnson', domain: 'nasa.example' }, { full_name: 'Alan Turing' }, {},
]
const plain = await same('a waterfall, an item missing an input and an empty one', FIND, people)
check('every item counted, priced, nothing reused', plain?.rows_to_process === 5 && plain.price_known
  && (plain.estimated_cost_usd?.high ?? 0) > 0 && plain.reuse.rows === 0, plain)

await answersFor(FIND, people, [0, 2])
const reused = await same('two items with a found answer for the same inputs', FIND, people)
check('...those two reuse it at $0, so it costs less', reused?.reuse.rows === 2 && reused.rows_to_process === 5
  && (reused.estimated_cost_usd?.high ?? 0) < (plain?.estimated_cost_usd?.high ?? 0), { reused, plain })

const hunter = 'hunter.people.email.find'
const one = await same('a single tool, two of its fields', hunter, [{ domain: 'acme.example', full_name: 'Ada' }],
  ['data.email', 'data.score'])
check('...priced', one?.price_known === true && (one.estimated_cost_usd?.high ?? 0) > 0, one)
await same('an email check, whose "status" field moves the status column aside', 'treg.people.email.verify',
  [{ email: 'ada@acme.example' }, { email: 'grace@navy.example' }])
const unpriced = await same('a tool with no known price', OWN, [{ email: 'ada@acme.example' }])
check('...says so', unpriced?.price_known === false && unpriced.estimated_cost_usd === null, unpriced)

// Starts refused before anything is made, the estimate's numbers the same as on a table.
await refused('over max_cost_usd, with items reusing an answer', /max_cost_usd/, { maxCostUsd: 0.000001 })
await refused('no known price', /allow_unpriced/, { toolId: OWN, items: [{ email: 'ada@acme.example' }] })
setDailyLimitMicro(uid, 1)
const daily = await same('today\'s limit nearly spent', FIND, people)
check('...may pass it', daily?.may_pass_daily_limit === true, daily)
await refused('past today\'s limit', /today's enrichment limit/, {})
setDailyLimitMicro(uid, null)
await mockState({ balanceMicro: 1 })
const poor = await same('a treg balance nearly spent', FIND, people)
check('...may pass it', poor?.may_pass_balance === true, poor)
await refused('past the treg balance', /treg balance/, {})
await fetch(`${TREG}/__mock/reset`, { method: 'POST' })
await refused('past the token\'s spend cap', /spend cap/, {}, token(0.000001))

treg.kill()
if (failures > 0) { console.error(`${failures} enrich-call-estimate check(s) failed`); process.exit(1) }
console.log('enrich-call-estimate: all assertions passed')
passed()
