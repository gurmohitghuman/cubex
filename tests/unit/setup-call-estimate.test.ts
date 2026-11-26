// A setup call's estimate (services/setup-call-estimate.ts), on a migrated throwaway DB with OpenRouter's model list
// served by a stand-in and treg by the repo's mock (tests/mock-treg, started here and stopped by its PID):
//   - it is a pure read: no table, sheet, row, column, run, setup run or call is made, and nothing is written;
//   - it prices what the setup's estimate on a sheet holding the same items prices (what a call's estimate gave
//     when it made a working table), step by step: AI steps (priced; with a rule judged on each item; reading an
//     earlier step's column; on a model with no price), an enrichment, an HTTP API step and free steps, with
//     max_cost_usd's check, and with a ceiling it passes;
//   - its refusals are a sheet estimate's (a model OpenRouter doesn't list, a webhook that isn't there).
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const openRouter = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    const priced = { prompt: '0.00001', completion: '0.00003' }
    res.end(JSON.stringify({ data: [{ id: 'test/priced', name: 'p', pricing: priced },
      { id: 'test/varies', name: 'v', pricing: { prompt: '-1', completion: '-1' } }] }))
  })
})
await new Promise<void>(resolve => openRouter.listen(0, '127.0.0.1', resolve))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(openRouter.address() as AddressInfo).port}/api/v1`
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

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { insertSetup } = await import('../../server/src/services/setup-library')
const { callSetup } = await import('../../server/src/services/setup-call')
const { applySetup } = await import('../../server/src/services/setup-apply')
const { createTable } = await import('../../server/src/services/table-crud')
const { addSheetColumn } = await import('../../server/src/services/column-add')
const { appendRows } = await import('../../server/src/services/rows-write')
type Spec = import('../../server/src/lib/setups/spec').SetupSpec
runMigrations()
console.warn = () => {}

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const ai = (name: string, prompt: string, model: string, runIf: string | null = null) => ({
  kind: 'ai' as const, name, prompt, systemPrompt: null, model, temperature: 0.7, maxChars: null, concurrency: null,
  webSearch: false, webFetch: false, search: null, outputColumns: null, runIf,
})
const spec: Spec = { v: 1, inputs: ['Name', 'Country', 'Site'], keys: [], steps: [
  { kind: 'clean', name: 'Trimmed', source: 'Name', cleaner: 'trim', options: {}, autoRun: false },
  ai('Summary', 'Describe /Name from /Country in a few words', 'test/priced'),
  ai('Greeting', 'Say hello to /Name', 'test/priced', '{{Country}} is "US"'),
  ai('Short', 'Shorten /summary_output', 'test/priced'),
  ai('Odd', 'Rate /Name', 'test/varies'),
  {
    kind: 'enrichment', name: 'Email', autoRun: null, toolId: 'treg.people.email.find', toolName: 'Email',
    preset: null, inputs: { domain: { column: 'Site' }, full_name: { column: 'Name' } }, cleanDomains: false,
    providerOrder: [], skipProviders: [], stopAtFirst: true, email: null,
    outputs: [{ key: 'email', path: '$.output.email', columnName: 'Work email' }], conditions: [], runIf: null,
    maxCostPerRowUsd: null, concurrency: null, fresh: false,
  },
  { kind: 'http', name: 'Lookup', request: { method: 'GET', url: 'https://example.com/?q={{Name}}', headers: {},
    body: null, timeout: null }, mappings: [{ jsonPath: '$.a', columnName: 'A' }], batchSize: null, runIf: null,
  autoRun: null },
  { kind: 'formula', name: 'Len', formula: '{{Trimmed}}.length', description: null, autoRun: false },
] }
const made = insertSetup(uid, 'Everything', null, spec)
if (!('ok' in made)) throw new Error(JSON.stringify(made))
const setupId = made.ok.id
const items = [
  { Name: '  Ada Lovelace ', Country: 'UK', Site: 'ada.example' },
  { Name: 'Grace Hopper', Country: 'US', Site: 'navy.example' },
  { Name: 'Katherine Johnson with a much longer name than the others', Country: 'us', Site: 'nasa.example' },
  { Name: 'Alan', Site: 'turing.example' },
  { Country: 'US' },
]
const caller = { hasSecretsScope: true }

// What the database holds: row counts of every table a call or an estimate could touch, and every change made on
// this connection since it opened.
const counted = ['tables', 'sheets', 'rows', 'ai_runs', 'http_runs', 'setup_runs', 'setup_calls', 'call_sheets',
  'trash_items', 'sheet_changes', 'sheet_views']
const snapshot = () => ({
  ...Object.fromEntries(counted.map(t => [t, db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get() as number])),
  changes: db.prepare('SELECT total_changes()').pluck().get() as number,
})

// The table-based estimate, as a call's estimate made it before: a sheet with one column per input holding the
// items, priced by apply_setup's estimate.
async function onASheet(ceiling: { maxCostUsd?: number; allowUnpriced?: boolean } = {}) {
  const t = createTable(uid, `Same items ${uuid()}`)
  if (!('ok' in t)) throw new Error(JSON.stringify(t))
  for (const name of spec.inputs) addSheetColumn(t.ok.sheetId, uid, name, { seedEmptyRow: false })
  appendRows(t.ok.sheetId, uid, items as Array<Record<string, string>>)
  const out = await applySetup(uid, t.ok.sheetId, setupId, { estimateOnly: true, firstRows: null, call: true,
    maxCostUsd: ceiling.maxCostUsd ?? null, allowUnpriced: ceiling.allowUnpriced }, caller)
  if (!('ok' in out) || !('estimate' in out.ok)) throw new Error(JSON.stringify(out))
  return { estimate: out.ok.estimate, makes: out.ok.makes }
}

for (const [label, ceiling] of [
  ['no ceiling', {}], ['a ceiling it may pass', { maxCostUsd: 0.0001 }],
  ['a generous ceiling, unpriced let in', { maxCostUsd: 100, allowUnpriced: true }],
] as Array<[string, { maxCostUsd?: number; allowUnpriced?: boolean }]>) {
  const before = snapshot()
  const out = await callSetup(uid, setupId, items, { estimateOnly: true, ...ceiling }, caller)
  const after = snapshot()
  check(`${label}: the estimate writes nothing`, JSON.stringify(before) === JSON.stringify(after), { before, after })
  if (!('ok' in out) || !('estimate' in out.ok)) { check(`${label}: priced`, false, out); continue }
  const sheet = await onASheet(ceiling)
  check(`${label}: the same estimate as on a sheet with the same items`,
    JSON.stringify(out.ok.estimate) === JSON.stringify(sheet.estimate), { call: out.ok.estimate, sheet })
  check(`${label}: the same columns made`, out.ok.makes.join() === sheet.makes.join() && out.ok.items === 5, out.ok)
}

// What the numbers say, so a match above can't be two empty estimates.
const out = await callSetup(uid, setupId, items, { estimateOnly: true }, caller)
const e = 'ok' in out && 'estimate' in out.ok ? out.ok.estimate as unknown as {
  rows: number; low_usd: number; high_usd: number; unpriced: string[];
  steps: Array<{ column: string; rows: number; low_usd: number | null; free: boolean; sends_requests: boolean }>
} : null
const step = (column: string) => e?.steps.find(s => s.column === column)
check('every item counted', e?.rows === 5, e)
check('an AI step is priced on every item', step('Summary (Output)')?.rows === 5
  && (step('Summary (Output)')?.low_usd ?? 0) > 0, step('Summary (Output)'))
check('a rule is judged on each item (US, us and US: 3 of 5)', step('Greeting (Output)')?.rows === 3,
  step('Greeting (Output)'))
check('a model with no price is unpriced', e?.unpriced.includes('Odd (Output)') === true, e?.unpriced)
check('the enrichment is priced', (step('Email')?.low_usd ?? 0) > 0, step('Email'))
check('the HTTP API step sends requests, clean and formula are free', step('Lookup')?.sends_requests === true
  && step('Trimmed')?.free === true && step('Len')?.free === true)
check('the total adds up the priced steps', e !== null && e.high_usd > 0 && e.low_usd > 0)

// A refusal is a sheet estimate's, and writes nothing either: a model OpenRouter doesn't list, a webhook that
// isn't there.
for (const [label, extra, says] of [
  ['a model that isn\'t listed', { models: { 'Summary (Output)': 'test/gone' } }, 'isn\'t on OpenRouter'],
  ['a webhook that isn\'t there', { webhookId: uuid() }, ''],
] as Array<[string, Record<string, unknown>, string]>) {
  const before = snapshot()
  const refused = await callSetup(uid, setupId, items, { estimateOnly: true, ...extra }, caller)
  const after = snapshot()
  check(`refused: ${label}, writing nothing`, 'fail' in refused && refused.fail === 'bad_request'
    && refused.message.includes(says) && JSON.stringify(before) === JSON.stringify(after), { refused, before, after })
}

openRouter.close()
treg.kill()
if (failures > 0) { console.error(`${failures} setup-call-estimate check(s) failed`); process.exit(1) }
console.log('setup-call-estimate: all assertions passed')
passed()
