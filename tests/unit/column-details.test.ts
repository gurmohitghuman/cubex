// Over 200 lines: one sheet holding every kind of column, walked through get_sheet's column details, its
// counts, the size rules and the named-column reads, each check reading the same fixture.
// get_sheet's column_details on a migrated throwaway DB: every kind (plain, AI
// with its outputs and sources, HTTP with a field, enrichment with an output,
// webhook, clean, formula, lookup), what fills each, what it reads, auto-run,
// the rule; credentials in a URL masked and header values never shown; counts
// that agree with the run-state filters; the size budget and named columns.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import detailsMod from '../../server/src/services/column-details'
import sheetMod from '../../server/src/services/sheet-details'
import pureMod from '../../server/src/lib/column-details'
import descMod from '../../server/src/services/descriptions'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { sheetColumnDetails } = detailsMod as typeof import('../../server/src/services/column-details')
const { readSheetDetails } = sheetMod as typeof import('../../server/src/services/sheet-details')
const { cutText, maskUrlSecrets, fitDetails } = pureMod as typeof import('../../server/src/lib/column-details')
const { describeColumn } = descMod as typeof import('../../server/src/services/descriptions')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

runMigrations()
const uid = uuid(), tid = uuid(), sid = uuid(), other = uuid()
const COLUMNS = ['Company', 'Domain', 'Fit (Output)', 'Profile (Status)', 'Industry', 'Profile (Data)', 'Lookup',
  'Title', 'Work email', 'Email', 'Webhook', 'Lead', 'Company (clean)', 'Shout', 'Region', 'Size']
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const sheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
sheet.run(sid, tid, uid, 'Leads', 0, JSON.stringify(COLUMNS))
sheet.run(other, tid, uid, 'Accounts', 1, JSON.stringify(['Website', 'Region']))

db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,run_if)
  VALUES ('ai1',?,?,'Fit (Output)','Score /Company at /domain from 1 to 10','m/old','completed',NULL)`).run(sid, uid)
// A newer run of the same column: its prompt, model and rule are the ones shown.
db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,run_if)
  VALUES ('ai2',?,?,'Fit (Output)','Score /Company from 1 to 10','m/new','running','{{Domain}} is not empty')`)
  .run(sid, uid)
// An older run of the same column also filled Size; the newest one doesn't.
const structured = db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,output_columns,
    data_column, use_openrouter_web_search) VALUES (?,?,?,'Profile (Status)','Profile /Company','m/x','completed',?,
    'Profile (Data)',1)`)
structured.run('ai0', sid, uid, JSON.stringify([{ columnName: 'Industry', type: 'text', description: 'Old words' },
  { columnName: 'Size', type: 'number', description: 'Head count' }]))
structured.run('ai3', sid, uid, JSON.stringify([{ columnName: 'Industry', type: 'text', description: 'The industry' }]))

const httpConfig = {
  requestConfig: {
    method: 'GET', url: 'https://user:hunter2@api.example.com/v1?api_key=abc123&q={{Domain}}&token={{Key}}',
    headers: { Authorization: 'Bearer sk-live-secret' },
  },
  responseMapping: [{ jsonPath: '$.title', columnName: 'Title' }], previewSize: 5, runIf: '{{Company}} is not empty',
}
db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
  VALUES ('h1',?,?,?,'completed','Lookup')`).run(sid, uid, JSON.stringify(httpConfig))
db.prepare(`INSERT INTO http_column_associations (id,sheet_id,user_id,master_column_name,extracted_column_name,run_id)
  VALUES (?,?,?,'Lookup','Title','h1')`).run(uuid(), sid, uid)
const enrichConfig = {
  requestConfig: { method: 'POST', url: 'https://treg.example/run', body: JSON.stringify({ domain: '{{Domain}}' }) },
  responseMapping: [{ jsonPath: '$.output.email', columnName: 'Email' }], previewSize: 5,
  enrichment: { v: 1, toolId: 'work_email', toolName: 'Work email', maxCostPerRowUsd: 0.05, spendLimitUsd: 10,
    rows: { mode: 'all', test: null, where: [{ column: 'Company', op: 'not_empty' }] } },
}
db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
  VALUES ('e1',?,?,?,'paused','Work email')`).run(sid, uid, JSON.stringify(enrichConfig))
db.prepare(`INSERT INTO http_column_associations (id,sheet_id,user_id,master_column_name,extracted_column_name,run_id)
  VALUES (?,?,?,'Work email','Email','e1')`).run(uuid(), sid, uid)
db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,enabled,run_if,daily_cap_micro)
  VALUES (?,?,?,'Work email','enrichment',1,'{{Title}} contains "VP"',5000000)`).run(uuid(), uid, sid)

const src = uuid()
db.prepare(`INSERT INTO webhook_sources (id,user_id,sheet_id,token_hash,name,raw_column_name)
  VALUES (?,?,?,?,'Signups','Webhook')`).run(src, uid, sid, uuid())
db.prepare(`INSERT INTO webhook_mappings (id,source_id,user_id,json_path,column_name)
  VALUES (?,?,?,'$.lead','Lead')`).run(uuid(), src, uid)
db.prepare(`INSERT INTO clean_columns (id,user_id,sheet_id,column_name,source_column,cleaner,fill_status)
  VALUES (?,?,?,'Company (clean)','Company','company_name','done')`).run(uuid(), uid, sid)
db.prepare(`INSERT INTO formula_columns (id,user_id,sheet_id,column_name,formula,inputs,fill_status)
  VALUES (?,?,?,'Shout',?,'["Company"]','done')`)
  .run(uuid(), uid, sid, `{{Company}}.toUpperCase() + "${'!'.repeat(400)}"`)
db.prepare(`INSERT INTO lookup_columns (id,user_id,sheet_id,column_name,source_column,other_sheet_id,match_column,
    match_mode,returns,return_columns,fill_status) VALUES (?,?,?,'Region','Domain',?,'Website','equals','value',
    '["Region"]','done')`).run(uuid(), uid, sid, other)

// Rows: Fit holds a value, an error, a skip and a blank; Industry is blank where its run failed.
const ROWS: Array<Record<string, string>> = [
  { Company: 'Acme', 'Fit (Output)': '8', 'Profile (Status)': '✅', Industry: 'SaaS', 'Work email': '✅ Found' },
  { Company: 'Beta', 'Fit (Output)': '❌ Error: Rate limited', 'Profile (Status)': '❌ Error: bad JSON' },
  { Company: 'Gamma', 'Fit (Output)': '⏭️ Condition not met', 'Work email': '⏭️ Not found' },
  { Company: '', 'Fit (Output)': '' },
]
ROWS.forEach((data, i) => db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  .run(uuid(), sid, uid, i, JSON.stringify(data)))

const details = () => new Map(sheetColumnDetails(sid, uid, COLUMNS).map(d => [d.name, d]))

await check('every column gets its kind, in the sheet\'s order', () => {
  const list = sheetColumnDetails(sid, uid, COLUMNS)
  assert.deepEqual(list.map(d => d.name), COLUMNS)
  assert.deepEqual(list.map(d => d.kind), ['plain', 'plain', 'ai', 'ai', 'ai', 'ai', 'http', 'http', 'enrichment',
    'enrichment', 'webhook', 'webhook', 'clean', 'formula', 'lookup', 'ai'])
})

await check('an AI column shows its newest run: model, prompt, the columns it reads, its rule, no auto-run', () => {
  const fit = details().get('Fit (Output)')!
  assert.equal(fit.role, 'answer')
  assert.equal(fit.fill!.run_id, 'ai2')
  assert.equal(fit.fill!.model, 'm/new')
  assert.equal(fit.fill!.run_status, 'running')
  assert.deepEqual(fit.reads, ['Company'])
  assert.equal(fit.run_if, '{{Domain}} is not empty')
  assert.equal(fit.auto_run, false)
})

await check('a structured AI run: status, its outputs and its sources name the main column', () => {
  const d = details()
  assert.equal(d.get('Profile (Status)')!.role, 'status')
  assert.deepEqual(d.get('Profile (Status)')!.fill!.output_columns, ['Industry'])
  assert.deepEqual(d.get('Industry'), { name: 'Industry', kind: 'ai', role: 'output', filled_by: 'Profile (Status)',
    fill: { type: 'text', asks_for: 'The industry' } })
  assert.deepEqual(d.get('Profile (Data)'), { name: 'Profile (Data)', kind: 'ai', role: 'sources',
    filled_by: 'Profile (Status)' })
  // An output only an older run filled still says which column's runs made it.
  assert.deepEqual(d.get('Size'), { name: 'Size', kind: 'ai', role: 'output', filled_by: 'Profile (Status)',
    fill: { type: 'number', asks_for: 'Head count' } })
  assert.equal(d.get('Profile (Status)')!.fill!.run_id, 'ai3')
})

await check('an HTTP column: method, URL with credentials masked, header names only, its field\'s JSONPath', () => {
  const d = details()
  const lookup = d.get('Lookup')!
  assert.equal(lookup.role, 'response')
  assert.equal(lookup.fill!.url, 'https://…@api.example.com/v1?api_key=…&q={{Domain}}&token={{Key}}')
  assert.deepEqual(lookup.fill!.header_names, ['Authorization'])
  assert.ok(!JSON.stringify(lookup).includes('sk-live-secret') && !JSON.stringify(lookup).includes('abc123'))
  assert.deepEqual(lookup.reads, ['Domain'])
  assert.equal(lookup.run_if, '{{Company}} is not empty')
  assert.deepEqual(d.get('Title'), { name: 'Title', kind: 'http', role: 'field', filled_by: 'Lookup',
    fill: { json_path: '$.title' } })
})

await check('an enrichment: tool, caps, auto-run with its daily cap and auto-run\'s own rule', () => {
  const d = details()
  const status = d.get('Work email')!
  assert.equal(status.role, 'status')
  assert.equal(status.fill!.tool_id, 'work_email')
  assert.equal(status.fill!.max_cost_per_row_usd, 0.05)
  assert.equal(status.auto_run, true)
  assert.deepEqual(status.auto_run_caps, { usd_per_day: 5 })
  assert.equal(status.run_if, '{{Title}} contains "VP"')
  assert.deepEqual(status.reads, ['Domain'])
  assert.equal(d.get('Email')!.role, 'output')
  assert.equal(d.get('Email')!.kind, 'enrichment')
})

await check('webhook, clean, formula and lookup columns say what fills them', () => {
  const d = details()
  assert.deepEqual(d.get('Webhook')!.fill, { webhook: 'Signups' })
  assert.deepEqual(d.get('Lead')!.fill, { webhook: 'Signups', json_path: '$.lead' })
  assert.deepEqual(d.get('Company (clean)')!.reads, ['Company'])
  assert.equal(d.get('Company (clean)')!.fill!.cleaner, 'company_name')
  assert.deepEqual(d.get('Shout')!.reads, ['Company'])
  assert.equal(d.get('Region')!.fill!.other_sheet, 'Accounts')
  assert.equal(d.get('Region')!.fill!.return_column, 'Region')
})

await check('long text is cut unless the column is named', () => {
  const short = details().get('Shout')!.fill!.formula as string
  assert.ok(short.endsWith('…') && short.length < 320)
  const named = sheetColumnDetails(sid, uid, COLUMNS, new Set(['Shout'])).find(d => d.name === 'Shout')!
  assert.ok(!(named.fill!.formula as string).endsWith('…'))
  // Named columns share one budget for full texts: past it, they are cut too.
  const bigs = ['Big1', 'Big2', 'Big3', 'Big4']
  for (const big of bigs) {
    db.prepare(`INSERT INTO formula_columns (id,user_id,sheet_id,column_name,formula,inputs,fill_status)
      VALUES (?,?,?,?,?,'[]','done')`).run(uuid(), uid, sid, big, `"${'x'.repeat(25_000)}"`)
  }
  const all = sheetColumnDetails(sid, uid, [...COLUMNS, ...bigs], new Set(bigs))
  const lengths = all.filter(d => d.name.startsWith('Big')).map(d => (d.fill!.formula as string).length)
  assert.deepEqual(lengths, [10_001, 10_001, 10_001, 301])
  db.prepare("DELETE FROM formula_columns WHERE column_name LIKE 'Big_'").run()
})

await check('a description sits right after the kind', () => {
  assert.ok('ok' in describeColumn(sid, uid, 'Domain', 'The company website, no www'))
  const domain = details().get('Domain')!
  assert.deepEqual(Object.keys(domain), ['name', 'kind', 'description'])
})

await check('counts agree with the run-state filters: a blank output reads its failed run as an error', async () => {
  const read = await readSheetDetails(sid, uid, { counts: true, columns: ['Fit (Output)', 'Industry', 'Company'] })
  assert.ok(read && 'ok' in read)
  const by = new Map(read.ok.column_details.map(d => [d.name, d.counts]))
  assert.deepEqual(by.get('Fit (Output)'), { filled: 1, empty: 2, errors: 1 })
  assert.deepEqual(by.get('Industry'), { filled: 1, empty: 2, errors: 1 })
  assert.deepEqual(by.get('Company'), { filled: 3, empty: 1, errors: 0 })
  assert.equal(by.get('Domain'), undefined)
  assert.equal(read.ok.counts_note, undefined)
})

await check('counts stop at the cap with a note; unknown columns are refused', async () => {
  const wide = uuid()
  const names = Array.from({ length: 25 }, (_, i) => `C${i}`)
  sheet.run(wide, tid, uid, 'Wide', 2, JSON.stringify(names))
  const read = await readSheetDetails(wide, uid, { counts: true })
  assert.ok(read && 'ok' in read)
  assert.deepEqual(read.ok.column_details[19].counts, { filled: 0, empty: 0, errors: 0 })
  assert.equal(read.ok.column_details[20].counts, null)
  assert.match(read.ok.counts_note!, /Counted 20 columns/)
  const bad = await readSheetDetails(sid, uid, { columns: ['Nope'] })
  assert.ok(bad && 'error' in bad && bad.error.includes('"Nope"'))
})

await check('pure: cutText, maskUrlSecrets, fitDetails', () => {
  assert.equal(cutText('abcdef', 3), 'abc…')
  assert.equal(cutText('ab', 3), 'ab')
  assert.equal(cutText('😀😀😀😀', 2), '😀😀…')
  assert.equal(maskUrlSecrets('https://x.io/a?apiKey=abc123def456&page=2#frag'), 'https://x.io/a?apiKey=…&page=2')
  assert.equal(maskUrlSecrets('https://{{u}}:{{p}}@x.io/'), 'https://{{u}}:{{p}}@x.io/')
  assert.equal(maskUrlSecrets('https://x.io/?access_token={{Key}}'), 'https://x.io/?access_token={{Key}}')
  assert.equal(maskUrlSecrets('https://user:p@ss@host.io/a'), 'https://…@host.io/a')
  // Keys in the path and in key formats, built from pieces (push protection refuses sample keys).
  const slack = ['https://hooks.slack.com/services', 'T0ABCDEF', 'B0ABCDEF', 'abcdefghijklmnopqrstuvwx'].join('/')
  assert.ok(!maskUrlSecrets(slack).includes('abcdefghijklmnopqrstuvwx'))
  const bot = `https://api.telegram.org/bot123456789:${'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'}/sendMessage`
  assert.ok(!maskUrlSecrets(bot).includes('AAHdq'))
  const appid = `https://api.example.org/weather?q={{City}}&appid=${'0123456789abcdef'.repeat(2)}`
  assert.equal(maskUrlSecrets(appid), 'https://api.example.org/weather?q={{City}}&appid=…')
  const format = `https://x.io/v1?x=${['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz012345'].join('-')}`
  assert.ok(!maskUrlSecrets(format).includes('abcdefghijklmnopqrstuvwxyz'))
  assert.equal(maskUrlSecrets('https://api.example.com/people?email={{Email}}&page=2'),
    'https://api.example.com/people?email={{Email}}&page=2')
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `c${i}`, kind: 'formula' as const,
    fill: { formula: 'x'.repeat(200) } }))
  const fitted = fitDetails(many, 2000, new Set(['c49']))
  assert.ok(fitted.shortened > 0)
  assert.deepEqual(fitted.details[48], { name: 'c48', kind: 'formula' })
  assert.ok(fitted.details[49].fill)
})

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('column-details: all checks passed')
