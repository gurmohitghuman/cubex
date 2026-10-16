// Saving setups against a migrated throwaway DB (services/setup-*.ts): a
// sheet's filled columns become steps (newest run, records, auto-run), a
// column picks its whole chain unless upstream is off, an AI column renamed
// since its run gets its run's name back in every step reading it, a list
// enrichment and a plain column are refused; the library (names unique
// ignoring case, rename, delete); export and import (a typed key refused).
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import saveMod from '../../server/src/services/setup-save'
import libMod from '../../server/src/services/setup-library'
import filesMod from '../../server/src/services/setup-files'
import keysMod from '../../server/src/services/saved-keys'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { planSetup, saveSetup, sheetSteps } = saveMod as typeof import('../../server/src/services/setup-save')
const { listSetups, updateSetup, deleteSetup } = libMod as typeof import('../../server/src/services/setup-library')
const { exportSetup, importSetup } = filesMod as typeof import('../../server/src/services/setup-files')
const { createSavedKey } = keysMod as typeof import('../../server/src/services/saved-keys')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), tableId = uuid(), sheetId = uuid()
const COLUMNS = ['Name', 'Website', 'Lookup', 'Response', 'Pair', 'Score (Output)', 'Score (Data)', 'Score clean',
  'Fit', 'Fit copy', 'People', 'Email', 'Email find']
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sheetId, tableId, uid, 'S', JSON.stringify(COLUMNS))
createSavedKey(uid, { name: 'apollo_key', key_type: 'bearer', key_value: 'k'.repeat(30), description: null })

const httpRun = (master: string, config: object, mapped: string[]) => {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
    VALUES (?,?,?,?,'completed',?)`).run(id, sheetId, uid, JSON.stringify(config), master)
  for (const m of mapped) {
    db.prepare(`INSERT INTO http_column_associations (id, sheet_id, user_id, master_column_name, extracted_column_name,
      run_id) VALUES (?,?,?,?,?,?)`).run(uuid(), sheetId, uid, master, m, id)
  }
}
const lookup = (auth: string) => ({
  requestConfig: { method: 'POST', url: 'https://api.example.com/find?d={{Website}}',
    headers: { Authorization: auth }, body: '{"name":"{{Name}}"}' },
  responseMapping: [{ jsonPath: '$', columnName: 'Response' }], previewSize: 1, runIf: '{{Website}} is not empty',
})
httpRun('Lookup', lookup('Bearer {{apollo_key}}'), ['Response'])
db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, enabled, daily_row_cap, run_if)
  VALUES (?,?,?,?,?,1,50,?)`).run(uuid(), uid, sheetId, 'Lookup', 'http', '{{Name}} is not empty')
db.prepare(`INSERT INTO formula_columns (id, user_id, sheet_id, column_name, formula, inputs, fill_status)
  VALUES (?,?,?,?,?,?, 'done')`).run(uuid(), uid, sheetId, 'Pair', '{{Response}}?.id + {{Name}}', '["Response","Name"]')
const aiRun = (column: string, prompt: string, web: number) => db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id,
  column_name, prompt, model, status, use_openrouter_web_search) VALUES (?,?,?,?,?,?,'completed',?)`)
  .run(uuid(), sheetId, uid, column, prompt, 'some/model', web)
aiRun('Score (Output)', 'Old prompt /name', 0) // an older run of the same column: the newest wins
aiRun('Score (Output)', 'Rate /pair for /website', 1)
db.prepare(`INSERT INTO clean_columns (id, user_id, sheet_id, column_name, source_column, cleaner, fill_status)
  VALUES (?,?,?,?,?,?, 'done')`).run(uuid(), uid, sheetId, 'Score clean', 'Score (Output)', 'trim')
aiRun('Fit', 'Fit of /score_output', 0) // renamed from "Fit (Output)" after its run
db.prepare(`INSERT INTO formula_columns (id, user_id, sheet_id, column_name, formula, inputs, fill_status)
  VALUES (?,?,?,?,?,?, 'done')`).run(uuid(), uid, sheetId, 'Fit copy', '{{Fit}}', '["Fit"]')
const block = {
  v: 1, toolId: 'treg.people.email.find', toolName: 'Find email', kind: 'waterfall', preset: null,
  toolSnapshot: {}, providerNames: {}, route: { prefer: ['a'], exclude: [], stopAtFirst: true }, cleanDomains: true,
  fresh: false, maxCostPerRowUsd: 0.05, spendLimitUsd: null, rows: { mode: 'all', test: null, where: [] }, email: null,
}
httpRun('Email find', {
  requestConfig: { method: 'POST', url: 'treg', headers: {}, body: '{"domain":"{{Website}}","full_name":"{{Name}}"}' },
  responseMapping: [{ jsonPath: '$._cubex.email', columnName: 'Email' }], previewSize: 1, enrichment: block,
}, ['Email'])
httpRun('People', { requestConfig: { method: 'POST', url: 'treg', headers: {}, body: '{}' }, responseMapping: [],
  previewSize: 1, enrichment: { ...block, list: { destSheetId: uuid(), copy: [] } } }, [])

const steps = sheetSteps(uid, sheetId)
const byColumn = (c: string) => ('ok' in steps ? steps.ok.find(s => s.column === c) : undefined)
check('the sheet lists its filled columns as steps', 'ok' in steps && steps.ok.length === 8, steps)
check('a step says what it reads', byColumn('Score (Output)')?.reads.join() === 'Pair,Website',
  byColumn('Score (Output)'))
check('a list enrichment says why it can\'t be saved', !!byColumn('People')?.problem?.includes('another sheet'))

const plan = planSetup(uid, sheetId, ['Score clean'])
const kinds = 'ok' in plan ? plan.ok.steps.map(s => `${s.kind}:${s.name}`).join() : ''
check('a column brings its chain, each step after what it reads',
  kinds === 'http:Lookup,formula:Pair,ai:Score,clean:Score clean', plan)
check('inputs are what the chain reads and makes nothing of', 'ok' in plan && plan.ok.inputs.join() === 'Website,Name',
  'ok' in plan && plan.ok.inputs)
check('saved keys are listed by name', 'ok' in plan && plan.ok.keys.join() === 'apollo_key')
const ai = 'ok' in plan ? plan.ok.steps[2] : null
check('an AI step is its newest run', ai?.kind === 'ai' && ai.prompt === 'Rate /pair for /website' && ai.webSearch, ai)
const look = 'ok' in plan ? plan.ok.steps[0] : null
check('an HTTP step keeps its rule and auto-run', look?.kind === 'http' && look.runIf === '{{Website}} is not empty'
  && look.autoRun?.dailyRowCap === 50 && look.autoRun.runIf === '{{Name}} is not empty', look)
const cl = 'ok' in plan ? plan.ok.steps[3] : null
check('a clean step without an auto-run entry has it off', cl?.kind === 'clean' && cl.autoRun === false, cl)

const alone = planSetup(uid, sheetId, ['Score clean'], false)
check('without upstream only the chosen step; what it reads is an input',
  'ok' in alone && alone.ok.steps.length === 1 && alone.ok.inputs.join() === 'Score (Output)', alone)

const fit = planSetup(uid, sheetId, ['Fit copy'])
const fitSteps = 'ok' in fit ? fit.ok.steps : []
check('a renamed AI column gets back the name its run makes',
  fitSteps.some(s => s.kind === 'ai' && s.name === 'Fit'), fitSteps)
check('and the steps reading it read that name', fitSteps.some(s => s.kind === 'formula'
  && s.formula === '{{Fit (Output)}}'), fitSteps)

const enrich = planSetup(uid, sheetId, ['Email'])
const e = 'ok' in enrich ? enrich.ok.steps[0] : null
check('an output column picks its enrichment, recalled with its inputs', e?.kind === 'enrichment'
  && e.name === 'Email find'
  && JSON.stringify(e.inputs) === '{"domain":{"column":"Website"},"full_name":{"column":"Name"}}'
  && e.outputs[0]?.columnName === 'Email', e)
const people = planSetup(uid, sheetId, ['People'])
check('a list enrichment is refused', 'fail' in people && people.message.includes('another sheet'), people)
const plain = planSetup(uid, sheetId, ['Name'])
check('a plain column is refused', 'fail' in plain && plain.message.includes("isn't a filled column"), plain)
const nothing = planSetup(uid, sheetId, ['Nope'])
check('an unknown column is refused', 'fail' in nothing && nothing.message.includes('no column'), nothing)

const saved = saveSetup(uid, sheetId,
  { name: '  Lead   score ', description: 'Scores leads', columns: ['Score clean'] })
check('a setup saves with its name tidied', 'ok' in saved && saved.ok.name === 'Lead score'
  && saved.ok.steps.length === 4, saved)
const again = saveSetup(uid, sheetId, { name: 'lead SCORE', columns: ['Pair'] })
check('a name taken (ignoring case) is refused', 'fail' in again && again.fail === 'conflict', again)
check('no name is refused', 'fail' in saveSetup(uid, sheetId, { columns: ['Pair'] }))
const second = saveSetup(uid, sheetId, { name: 'Pair only', columns: ['Pair'], includeUpstream: false })
check('a second setup saves', 'ok' in second, second)
if ('ok' in saved && 'ok' in second) {
  check('the list is by name', listSetups(uid).map(s => s.name).join() === 'Lead score,Pair only')
  const clash = updateSetup(uid, second.ok.id, { name: 'LEAD score' })
  check('renaming onto another setup\'s name is refused', 'fail' in clash && clash.fail === 'conflict', clash)
  const renamed = updateSetup(uid, second.ok.id, { name: 'Pair', description: '' })
  check('a rename and an emptied description', 'ok' in renamed && renamed.ok.name === 'Pair'
    && renamed.ok.description === null, renamed)

  const exported = exportSetup(uid, saved.ok.id)
  check('a setup exports, keys by name only', 'ok' in exported && exported.ok.file.spec.keys.join() === 'apollo_key'
    && !JSON.stringify(exported.ok.file).includes('kkkkkkkkkk')
    && exported.ok.filename === 'lead-score.cubex-setup.json',
  exported)
  if ('ok' in exported) {
    const imported = importSetup(uid, JSON.parse(JSON.stringify(exported.ok.file)))
    check('importing it again adds (2) to the name and keeps the steps', 'ok' in imported
      && imported.ok.name === 'Lead score (2)'
      && JSON.stringify(imported.ok.spec) === JSON.stringify(exported.ok.file.spec), imported)
    check('a file of another format is refused', 'fail' in importSetup(uid, { ...exported.ok.file, format: 'x' }))
    const broken = importSetup(uid, { ...exported.ok.file, spec: { ...exported.ok.file.spec, inputs: [] } })
    check('a file with a broken setup is refused, saying why', 'fail' in broken
      && broken.message.includes("can't be used"), broken)
  }
  check('deleting a setup', 'ok' in deleteSetup(uid, second.ok.id) && listSetups(uid).length === 2)
  check('deleting it twice is not found', 'fail' in deleteSetup(uid, second.ok.id))
}

// A key typed into a request: saved locally, never exported.
db.prepare('UPDATE http_runs SET config = ? WHERE master_column_name = ?')
  .run(JSON.stringify(lookup(`Bearer ${['ab12', 'cd34', 'ef56', 'gh78', 'ij90', 'kl12', 'mn34', 'op56'].join('')}`)),
    'Lookup')
const typed = saveSetup(uid, sheetId, { name: 'Typed', columns: ['Lookup'] })
check('a column with a key typed into its request is refused, naming where', 'fail' in typed
  && typed.message.includes('Authorization header'), typed)
const typedSteps = sheetSteps(uid, sheetId)
check('and the dialog shows why', 'ok' in typedSteps
  && !!typedSteps.ok.find(s => s.column === 'Lookup')?.problem?.includes('typed'), typedSteps)
const around = planSetup(uid, sheetId, ['Score clean'])
check('a column read further up that can\'t be saved stays out: what it made is an input', 'ok' in around
  && !around.ok.steps.some(s => s.name === 'Lookup') && around.ok.inputs.includes('Response'), around)

// Text a column allows (an output column's long description) saves and reads back whole.
db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, output_columns)
  VALUES (?,?,?,?,?,?,'completed',?)`).run(uuid(), sheetId, uid, 'Long (Status)', 'Describe /name', 'some/model',
  JSON.stringify([{ columnName: 'Summary', type: 'string', description: 'd'.repeat(2500) }]))
db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?')
  .run(JSON.stringify([...COLUMNS, 'Long (Status)', 'Summary']), sheetId)
const long = saveSetup(uid, sheetId, { name: 'Long', columns: ['Summary'] })
check('a long output description saves and reads back', 'ok' in long && long.ok.steps.length === 1
  && long.ok.spec.steps[0].kind === 'ai', long)

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall setup-save checks passed')
