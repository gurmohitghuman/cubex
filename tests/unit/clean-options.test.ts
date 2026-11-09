// The clean data options (lib/clean/cleaners.ts) and their way through the
// service MCP's clean_column and REST's POST /sheets/:id/clean-columns share
// (services/clean-agent.ts), against a migrated throwaway DB: name_input on
// first_name and last_name, the_company on company_name, accepted pairs and
// refusals with their exact words (every problem named at once, nothing
// written), a saved record read back, the fill using them with blank_rows
// counted, and the answer's keys unchanged for a column without them.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import cleanersMod from '../../server/src/lib/clean/cleaners'
import serviceMod from '../../server/src/services/clean-agent'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { parseCleanOptions, cleanerForRecord } = cleanersMod as typeof import('../../server/src/lib/clean/cleaners')
const { agentCleanColumn } = serviceMod as typeof import('../../server/src/services/clean-agent')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

const NAME_INPUT_ELSEWHERE = 'name_input is an option of the first_name cleaner (full_name or first_name) and the '
  + 'last_name cleaner (full_name or last_name) only.'
const FIRST_PAIR = 'name_input on the first_name cleaner must be full_name or first_name.'
const LAST_PAIR = 'name_input on the last_name cleaner must be full_name or last_name.'
const THE_COMPANY_ELSEWHERE = 'the_company is an option of the company_name cleaner only: strip or keep.'
const THE_COMPANY_VALUE = 'the_company must be strip or keep.'
const PHONE_ELSEWHERE = 'phoneFormat and phoneCountry are options of the phone cleaner only.'

await ok('accepted pairs', () => {
  assert.deepEqual(parseCleanOptions('first_name', { nameInput: 'first_name' }), { ok: { nameInput: 'first_name' } })
  assert.deepEqual(parseCleanOptions('first_name', { nameInput: 'full_name' }), { ok: { nameInput: 'full_name' } })
  assert.deepEqual(parseCleanOptions('last_name', { nameInput: 'last_name' }), { ok: { nameInput: 'last_name' } })
  assert.deepEqual(parseCleanOptions('last_name', { nameInput: 'full_name' }), { ok: { nameInput: 'full_name' } })
  assert.deepEqual(parseCleanOptions('company_name', { theCompany: 'keep' }), { ok: { theCompany: 'keep' } })
  assert.deepEqual(parseCleanOptions('company_name', { theCompany: 'strip' }), { ok: { theCompany: 'strip' } })
  // Left out or null: the defaults.
  assert.deepEqual(parseCleanOptions('first_name', { nameInput: null, theCompany: null }), { ok: {} })
  assert.deepEqual(parseCleanOptions('phone', { phoneFormat: 'e164', phoneCountry: 'gb' }),
    { ok: { phoneFormat: 'e164', phoneCountry: 'GB' } })
})

await ok('refused: another pair, another cleaner, another value, in these words', () => {
  assert.deepEqual(parseCleanOptions('first_name', { nameInput: 'last_name' }), { error: FIRST_PAIR })
  assert.deepEqual(parseCleanOptions('last_name', { nameInput: 'first_name' }), { error: LAST_PAIR })
  assert.deepEqual(parseCleanOptions('first_name', { nameInput: 'nickname' }), { error: FIRST_PAIR })
  for (const c of ['person_name', 'company_name', 'email', 'phone', 'trim'] as const) {
    assert.deepEqual(parseCleanOptions(c, { nameInput: 'full_name' }), { error: NAME_INPUT_ELSEWHERE }, c)
  }
  for (const c of ['person_name', 'first_name', 'last_name', 'domain'] as const) {
    assert.deepEqual(parseCleanOptions(c, { theCompany: 'keep' }), { error: THE_COMPANY_ELSEWHERE }, c)
  }
  assert.deepEqual(parseCleanOptions('company_name', { theCompany: 'drop' }), { error: THE_COMPANY_VALUE })
  // Phone's own words are as they were.
  assert.deepEqual(parseCleanOptions('person_name', { phoneFormat: 'e164' }), { error: PHONE_ELSEWHERE })
  assert.deepEqual(parseCleanOptions('first_name', { name_input: 'first_name' }),
    { error: 'Unknown option "name_input".' })
})

await ok('every problem is named in one answer', () => {
  const all = { phoneFormat: 'e164', nameInput: 'first_name', theCompany: 'keep' }
  assert.deepEqual(parseCleanOptions('person_name', all),
    { error: `${PHONE_ELSEWHERE} ${NAME_INPUT_ELSEWHERE} ${THE_COMPANY_ELSEWHERE}` })
  assert.deepEqual(parseCleanOptions('first_name', { nameInput: 'last_name', theCompany: 'keep' }),
    { error: `${FIRST_PAIR} ${THE_COMPANY_ELSEWHERE}` })
})

await ok('a saved record cleans with its options; a pair this version refuses reads as the defaults', () => {
  assert.equal(cleanerForRecord('first_name', '{"nameInput":"first_name"}')!('Dr. Sarah'), 'Sarah')
  assert.equal(cleanerForRecord('last_name', '{"nameInput":"last_name"}')!('SMITH JONES'), 'Smith Jones')
  assert.equal(cleanerForRecord('company_name', '{"theCompany":"keep"}')!('The Christman Company'),
    'The Christman Company')
  assert.equal(cleanerForRecord('first_name', '{"nameInput":"last_name"}')!('Dr. Sarah'), '')
  assert.equal(cleanerForRecord('company_name', '{}')!('The Christman Company'), 'Christman')
})

// A sheet to clean through the service MCP and REST share.
const uid = uuid(), tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sheetId, tableId, uid, 'S', JSON.stringify(['First', 'Last', 'Company']))
const ROWS = [
  { First: 'Dr. Sarah', Last: 'SMITH JONES', Company: 'The Christman Company' },
  { First: 'J. Michael', Last: 'VAN DER BERG', Company: 'Docsumo 📄' },
  { First: 'n/a', Last: 'Kowalski 👋', Company: 'ImagineSoftware (Technology Partners' },
  { First: 'Mr John', Last: 'unknown', Company: 'none' },
]
ROWS.forEach((r, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  .run(uuid(), sheetId, uid, i, JSON.stringify(r)))
const cells = (col: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(sheetId) as string[]).map(d => JSON.parse(d)[col] ?? '')
const columns = () => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
  .get(sheetId) as string) as string[]
const clean = (args: Record<string, unknown>) => agentCleanColumn(uid, sheetId, args)

await ok('name_input first_name: filled, blanks counted, echoed after cleaner', async () => {
  const out = await clean({ source_column: 'First', cleaner: 'first_name', name_input: 'first_name' })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.deepEqual(cells('First (first name)'), ['Sarah', 'Michael', '', 'John'])
  assert.deepEqual(Object.keys(out.ok), ['column', 'source_column', 'cleaner', 'name_input', 'auto_run', 'status',
    'cleaned_rows', 'blank_rows', 'created'])
  assert.equal(out.ok.name_input, 'first_name')
  assert.equal(out.ok.cleaned_rows, 3)
  assert.equal(out.ok.blank_rows, 1)
})

await ok('name_input last_name and the_company keep: filled and echoed', async () => {
  const last = await clean({ source_column: 'Last', cleaner: 'last_name', name_input: 'last_name' })
  assert.ok('ok' in last && last.ok.name_input === 'last_name', JSON.stringify(last))
  assert.deepEqual(cells('Last (last name)'), ['Smith Jones', 'van der Berg', 'Kowalski', ''])
  const company = await clean({ source_column: 'Company', cleaner: 'company_name', the_company: 'keep' })
  assert.ok('ok' in company && company.ok.the_company === 'keep' && company.ok.blank_rows === 1,
    JSON.stringify(company))
  assert.deepEqual(cells('Company (clean)'), ['The Christman Company', 'Docsumo', 'ImagineSoftware', ''])
})

await ok('a preview reads with the option', async () => {
  const p = await clean({ source_column: 'Last', cleaner: 'last_name', name_input: 'last_name', column: 'P',
    preview: true })
  assert.ok('ok' in p, JSON.stringify(p))
  assert.deepEqual((p.ok.samples as Array<{ after: string }>).map(s => s.after),
    ['Smith Jones', 'van der Berg', 'Kowalski', ''])
})

await ok('refused through the service with the same words, nothing written', async () => {
  const before = columns()
  assert.deepEqual(await clean({ source_column: 'First', cleaner: 'person_name', name_input: 'first_name' }),
    { fail: 'bad_request', message: NAME_INPUT_ELSEWHERE })
  assert.deepEqual(await clean({ source_column: 'First', cleaner: 'first_name', name_input: 'last_name' }),
    { fail: 'bad_request', message: FIRST_PAIR })
  assert.deepEqual(await clean({ source_column: 'Company', cleaner: 'company_name', the_company: 'drop' }),
    { fail: 'bad_request', message: THE_COMPANY_VALUE })
  const two = { source_column: 'Last', cleaner: 'last_name', the_company: 'keep', phone_format: 'e164' }
  assert.deepEqual(await clean(two),
    { fail: 'bad_request', message: `${PHONE_ELSEWHERE} ${THE_COMPANY_ELSEWHERE}` })
  assert.deepEqual(columns(), before)
})

await ok('without the new options the answer keeps its keys, in order', async () => {
  const out = await clean({ source_column: 'First', cleaner: 'trim' })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.deepEqual(Object.keys(out.ok), ['column', 'source_column', 'cleaner', 'auto_run', 'status', 'cleaned_rows',
    'blank_rows', 'created'])
})

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall clean-options checks passed')
process.exit(0)
