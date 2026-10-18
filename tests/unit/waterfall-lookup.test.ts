// Waterfall lookup steps against a migrated throwaway DB: the step as the app
// and the agents send it, checked against the sheet it looks in, matched by the
// run's step (the index made and built in this thread, equals and contains, the
// first match top first, a value that isn't the result type, a name read again
// after a rename there, a deleted column pausing the run), a rename there
// rewriting the newest run of the column only, and the lookup sweep keeping an
// index a waterfall reads and letting go of one none does.
// Over 200 lines: one scenario over two sheets, each step building on the last.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import stepsMod from '../../server/src/lib/waterfall/input-steps'
import argsMod from '../../server/src/lib/waterfall/agent-args'
import buildMod from '../../server/src/services/waterfall-build-lookup'
import runMod from '../../server/src/services/waterfall-step-lookup'
import typesMod from '../../server/src/services/waterfall-step-types'
import renameMod from '../../server/src/services/column-rename'
import refsMod from '../../server/src/lib/waterfall/lookup-refs'
import sweepMod from '../../server/src/services/waterfall-lookup-sweep'
import purgeMod from '../../server/src/services/lookup-purge'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { parseStep } = stepsMod as typeof import('../../server/src/lib/waterfall/input-steps')
const { agentWaterfallBody } = argsMod as typeof import('../../server/src/lib/waterfall/agent-args')
const { buildLookupStep, lookupStepsMoved } =
  buildMod as typeof import('../../server/src/services/waterfall-build-lookup')
const { RunLookups } = runMod as typeof import('../../server/src/services/waterfall-step-lookup')
const { STOP } = typesMod as typeof import('../../server/src/services/waterfall-step-types')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { waterfallLookupNeeds } = refsMod as typeof import('../../server/src/lib/waterfall/lookup-refs')
const { releaseWaterfallSources } = sweepMod as typeof import('../../server/src/services/waterfall-lookup-sweep')
const { lookupBackgroundRound } = purgeMod as typeof import('../../server/src/services/lookup-purge')
type LookupChoices = import('../../server/src/lib/waterfall/config').LookupChoices
type WaterfallStep = import('../../server/src/lib/waterfall/config').WaterfallStep

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

runMigrations()
const uid = uuid(), t1 = uuid(), t2 = uuid(), A = uuid(), B = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(t1, uid, 'Leads')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(t2, uid, 'CRM')
const sheet = db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
sheet.run(A, t1, uid, 'Leads', JSON.stringify(['Name', 'Domain', 'Work email']))
sheet.run(B, t2, uid, 'Contacts', JSON.stringify(['Website', 'Email', 'Notes']))
const add = (s: string, data: Record<string, string>) => {
  const i = (db.prepare('SELECT IFNULL(MAX(row_index), -1) + 1 FROM rows WHERE sheet_id = ?').pluck().get(s) as number)
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(uuid(), s, uid, i, JSON.stringify(data))
}
add(B, { Website: 'acme.com', Email: 'ada@acme.com', Notes: 'first' })
add(B, { Website: ' ACME.COM', Email: 'other@acme.com', Notes: 'second' })
add(B, { Website: 'globex.com', Email: 'not an email', Notes: 'x' })
add(B, { Website: 'initech.com', Email: '', Notes: 'Initech Software Ltd' })

const choices = (over: Partial<LookupChoices> = {}): LookupChoices => ({
  kind: 'lookup', sheetId: B, matchColumn: 'Website', mode: 'equals', inputKey: 'domain', returnColumn: 'Email',
  ...over,
})
const stepOf = (c: LookupChoices, id = 'slook01'): WaterfallStep =>
  ({ id, label: 'Contacts', on: true, requires: [['domain']], choices: c, built: { kind: 'lookup' } })
const w = { resultType: 'email' } as Parameters<InstanceType<typeof RunLookups>['run']>[0]['w']
const runConfig = (steps: WaterfallStep[]) => JSON.stringify({
  requestConfig: { method: 'POST', url: '', body: '{}' }, responseMapping: [], previewSize: 5,
  waterfall: { v: 1, resultType: 'email', inputs: [{ key: 'domain', label: 'Domain' }], steps,
    hideStepColumns: true, maxCostPerRowUsd: 0, tregCapPerRowUsd: 0, spendLimitUsd: null,
    rows: { mode: 'all', status: 'any', test: null }, fresh: false },
})
const addRun = (column: string | null, steps: WaterfallStep[]) => {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,?,'completed',?)`).run(id, A, uid, runConfig(steps), column)
  return id
}
const storedStep = (runId: string) => (JSON.parse(db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck()
  .get(runId) as string).waterfall.steps[0].choices as LookupChoices)

await check('the step as the app sends it: strict, equals by default', () => {
  const ok = parseStep({ choices: { kind: 'lookup', sheetId: B, matchColumn: 'Website', inputKey: 'domain',
    returnColumn: 'Email' } }, 0)
  assert.ok('ok' in ok)
  assert.equal(ok.ok.choices.kind === 'lookup' && ok.ok.choices.mode, 'equals')
  const stray = parseStep({ choices: { ...choices(), column: 'x' } }, 0)
  assert.ok('error' in stray && /column/.test(stray.error))
  assert.ok('error' in parseStep({ choices: { ...choices(), mode: 'like' } }, 0))
  assert.ok('error' in parseStep({ choices: { ...choices(), inputKey: 'Domain!' } }, 0))
})

await check('agents send it in snake_case', () => {
  const out = agentWaterfallBody({ sheet_id: A, column_name: 'Work email', result_type: 'email',
    inputs: { domain: 'Domain' }, steps: [{ kind: 'lookup', other_sheet_id: B, match_column: 'Website',
      match: 'contains', input: 'domain', return_column: 'Email' }] },
  null, null, { rowIndexes: null, generation: null })
  assert.ok('ok' in out)
  const step = (out.ok.steps as Array<{ choices: Record<string, unknown> }>)[0]
  assert.deepEqual(step.choices, { kind: 'lookup', sheetId: B, matchColumn: 'Website', mode: 'contains',
    inputKey: 'domain', returnColumn: 'Email' })
})

await check('checked against the sheet it looks in', () => {
  const ctx = { userId: uid, sheetId: A }
  const ok = buildLookupStep('Step 1', choices({ matchColumn: 'website', returnColumn: 'EMAIL' }), ctx, ['domain'])
  assert.ok('ok' in ok)
  assert.equal(ok.ok.sheetName, 'Contacts')
  assert.equal(ok.ok.choices.matchColumn, 'Website')
  assert.equal(ok.ok.choices.returnColumn, 'Email')
  const own = buildLookupStep('Step 1', choices({ sheetId: A }), ctx, ['domain'])
  assert.ok('fail' in own && /another sheet/.test(own.message))
  const missing = buildLookupStep('Step 1', choices({ returnColumn: 'Phone' }), ctx, ['domain'])
  assert.ok('fail' in missing && missing.message.includes('"Phone" isn\'t a column of "Contacts"'))
  const input = buildLookupStep('Step 1', choices({ inputKey: 'company' }), ctx, ['domain'])
  assert.ok('fail' in input && /inputs/.test(input.message))
})

const sourceCount = () => db.prepare('SELECT count(*) FROM lookup_sources WHERE sheet_id = ?').pluck().get(B) as number

await check('a run matches: the index made and built here, the first match top first', async () => {
  const step = stepOf(choices())
  const runId = addRun(null, [step])
  let halted: string | null = null
  const lookups = new RunLookups(runId, uid, () => false, false)
  const ask = (domain: string, s = step) => lookups.run({ w, step: s, given: s.choices as LookupChoices,
    inputs: { domain }, halt: m => { halted = m } })
  assert.equal(sourceCount(), 0)
  const r = await ask(' Acme.com')
  assert.notEqual(r, STOP)
  assert.deepEqual(r !== STOP && [r.outcome, r.value, r.costUsd], ['answered', 'ada@acme.com', 0])
  assert.equal(sourceCount(), 1)
  const none = await ask('nowhere.io')
  assert.equal(none !== STOP && none.outcome, 'not_found')
  // A value the result type can't read is no answer; an empty one says so.
  const bad = await ask('globex.com')
  assert.deepEqual(bad !== STOP && [bad.outcome, bad.got], ['not_found', 'not an email'])
  const empty = await ask('initech.com')
  assert.equal(empty !== STOP && empty.detail, 'The matching row has no value there.')
  // A row added there now is found by the next row.
  add(B, { Website: 'hooli.com', Email: 'gavin@hooli.com', Notes: '' })
  const added = await ask('hooli.com')
  assert.equal(added !== STOP && added.value, 'gavin@hooli.com')
  // Contains (the text index replaces the plain one); too short is no match.
  const notes = stepOf(choices({ mode: 'contains', matchColumn: 'Notes', returnColumn: 'Website' }), 'slook02')
  const runText = new RunLookups(addRun(null, [notes]), uid, () => false, false)
  const askText = (v: string) => runText.run({ w: { ...w, resultType: 'domain' } as typeof w, step: notes,
    given: notes.choices as LookupChoices, inputs: { domain: v }, halt: () => {} })
  const found = await askText('software')
  assert.equal(found !== STOP && found.value, 'initech.com')
  const short = await askText('so')
  assert.deepEqual(short !== STOP && [short.outcome, /at least/.test(short.detail ?? '')], ['not_found', true])
  assert.equal(halted, null)
})

await check('a rename there rewrites the newest run of each column; the run reads it again', async () => {
  const old = addRun('Work email', [stepOf(choices())])
  const newest = addRun('Work email', [stepOf(choices())])
  const done = await renameSheetColumn(B, uid, 'Email', 'Work Email')
  assert.ok(!('fail' in done), JSON.stringify(done))
  assert.equal(storedStep(newest).returnColumn, 'Work Email')
  assert.equal(storedStep(old).returnColumn, 'Email')
  const step = stepOf(choices())
  const lookups = new RunLookups(newest, uid, () => false, false)
  const r = await lookups.run({ w, step, given: step.choices as LookupChoices, inputs: { domain: 'acme.com' },
    halt: () => {} })
  assert.equal(r !== STOP && r.value, 'ada@acme.com')
  const needs = waterfallLookupNeeds(uid)
  assert.equal(needs.get(B)?.get('Website'), false)
})

await check('a column gone there pauses the run with why', async () => {
  const step = stepOf(choices({ returnColumn: 'Phone' }))
  const runId = addRun(null, [step])
  let halted: { message: string; reason?: string } | null = null
  const r = await new RunLookups(runId, uid, () => false, false).run({ w, step, given: step.choices as LookupChoices,
    inputs: { domain: 'acme.com' }, halt: (message, reason) => { halted = { message, reason } } })
  assert.equal(r, STOP)
  assert.equal(halted!.reason, 'setup')
  assert.ok(halted!.message.includes('the column "Phone" isn\'t in "Contacts" any more'))
})

await check('the sweep keeps an index a waterfall reads, and lets go of one none does', async () => {
  const age = (column: string) => db.prepare(`UPDATE lookup_sources SET created_at = datetime('now', '-1 hour')
    WHERE sheet_id = ? AND column_name = ?`).run(B, column)
  const has = (column: string) => db.prepare(`SELECT with_text FROM lookup_sources
    WHERE sheet_id = ? AND column_name = ?`).pluck().get(B, column) as number | undefined
  // What waterfalls read is kept a minute: the clock moves on past it.
  const now = Date.now
  let skew = 0
  Date.now = () => now() + skew
  const later = () => { skew += 61_000 }
  age('Website'); age('Notes')
  // Website: the newest run of "Work email" reads it (equals). Notes: only a dry run (no column) did.
  releaseWaterfallSources()
  assert.equal(has('Website'), 0)
  assert.equal(has('Notes'), undefined)
  // A contains step keeps the text index; once it's equals again, the index goes back to plain.
  // (Email was renamed Work Email above.)
  const contains = choices({ mode: 'contains', returnColumn: 'Work Email' })
  addRun('Work email', [stepOf(contains)])
  const step = stepOf(contains)
  const r = await new RunLookups(addRun(null, [step]), uid, () => false, false).run({ w, step, given: contains,
    inputs: { domain: 'acme' }, halt: () => {} })
  assert.equal(r !== STOP && r.value, 'ada@acme.com')
  assert.equal(has('Website'), 1)
  age('Website')
  await lookupBackgroundRound()
  assert.equal(has('Website'), 1)
  addRun('Work email', [stepOf(choices({ returnColumn: 'Work Email' }))])
  later()
  await lookupBackgroundRound()
  // Kept for the waterfall, made again without the text index; read nowhere, let go.
  assert.equal(has('Website'), 0)
  addRun('Work email', [])
  age('Website')
  later()
  releaseWaterfallSources()
  assert.equal(has('Website'), undefined)
  Date.now = now
})

const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
const settles = <T>(p: Promise<T>) => { const s = { done: false }; p.then(() => { s.done = true }); return s }

await check('a start sees a lookup step whose columns moved since it was built', () => {
  const cfg = (c: LookupChoices) => JSON.parse(runConfig([stepOf(c)]))
  assert.equal(lookupStepsMoved(cfg(choices({ returnColumn: 'Work Email' })), uid), false)
  assert.equal(lookupStepsMoved(cfg(choices({ returnColumn: 'Email' })), uid), true)
  assert.equal(lookupStepsMoved(cfg(choices({ sheetId: uuid(), returnColumn: 'Work Email' })), uid), true)
})

await check('it waits while that sheet imports, and while a run there fills the cell it would return', async () => {
  const step = stepOf(choices({ returnColumn: 'Work Email' }), 'slook04')
  const ask = () => new RunLookups(addRun(null, [step]), uid, () => false, false).run({ w, step,
    given: step.choices as LookupChoices, inputs: { domain: 'acme.com' }, halt: () => {} })
  db.prepare(`INSERT INTO import_jobs (sheet_id, user_id, is_replace, first_row, end_row, columns)
    VALUES (?, ?, 1, 0, 0, '[]')`).run(B, uid)
  const importing = ask()
  const s1 = settles(importing)
  await pause(800)
  assert.equal(s1.done, false)
  db.prepare('DELETE FROM import_jobs WHERE sheet_id = ?').run(B)
  const r1 = await importing
  assert.equal(r1 !== STOP && r1.value, 'ada@acme.com')
  // The first match's cell holds a running run's ⏳: the row waits for its value.
  const first = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY row_index LIMIT 1').pluck().get(B)
  const cell = db.prepare(`UPDATE rows SET data = json_set(data, '$."Work Email"', ?) WHERE rowid = ?`)
  cell.run('⏳ Processing...', first)
  const filler = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Work Email')`).run(filler, B, uid)
  const filling = ask()
  const s2 = settles(filling)
  await pause(800)
  assert.equal(s2.done, false)
  cell.run('ada@acme.com', first)
  db.prepare(`UPDATE http_runs SET status = 'completed' WHERE id = ?`).run(filler)
  const r2 = await filling
  assert.equal(r2 !== STOP && r2.value, 'ada@acme.com')
})

await check('a rename there seen half-way pauses a dry run and leaves no index on the old name', async () => {
  const step = stepOf(choices({ matchColumn: 'Notes', returnColumn: 'Work Email' }), 'slook03')
  // A dry run has no column of its own: a rename never rewrites it.
  const lookups = new RunLookups(addRun(null, [step]), uid, () => false, false)
  let halted = ''
  const ask = () => lookups.run({ w, step, given: step.choices as LookupChoices, inputs: { domain: 'first' },
    halt: m => { halted = m } })
  const t = Date.now()
  const before = await ask()
  assert.equal(before !== STOP && before.value, 'ada@acme.com')
  const done = await renameSheetColumn(B, uid, 'Notes', 'Note')
  assert.ok(!('fail' in done), JSON.stringify(done))
  // What the step read a moment ago still names "Notes": the clock held there, as within that second.
  const now = Date.now
  Date.now = () => t
  try { assert.equal(await ask(), STOP) } finally { Date.now = now }
  assert.ok(halted.includes('the column "Notes" isn\'t in "Contacts" any more'), halted)
  assert.equal(db.prepare(`SELECT count(*) FROM lookup_sources WHERE sheet_id = ? AND column_name = 'Notes'`)
    .pluck().get(B), 0)
})

if (failures) { console.log(`waterfall-lookup: ${failures} failed`); process.exit(1) }
console.log('waterfall-lookup: all checks passed')
