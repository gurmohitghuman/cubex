// What agents send to run_enrichment (MCP and /api/v1), mapped onto the
// drawer's run request and parsed by the same strict parser: inputs as
// columns or fixed values, outputs by field name, the preset's defaults,
// strict true/false flags (a "test" that isn't a boolean must never become a
// full run), where operators, list jobs (a test first), and the processing
// overlay agents' reads put on a column still filling. Pure: no network, no DB.
import fs from 'fs'
import agentMod from '../../server/src/lib/enrich-agent-input'
import inputMod from '../../server/src/lib/enrich-run-input'
import toolMod from '../../server/src/lib/enrich-tool'
import fillMod from '../../server/src/lib/field-fill-overlay'
import budgetMod from '../../server/src/lib/answer-budget'
import argsMod from '../../server/src/lib/enrich-agent-args'
const { agentRunBody, outputFields, flagOf } = agentMod as typeof import('../../server/src/lib/enrich-agent-input')
const { parseEnrichRunInput } = inputMod as typeof import('../../server/src/lib/enrich-run-input')
const { normalizeTool } = toolMod as typeof import('../../server/src/lib/enrich-tool')
const { budgetAnswer } = budgetMod as typeof import('../../server/src/lib/answer-budget')
const { unknownArgument } = argsMod as typeof import('../../server/src/lib/enrich-agent-args')
const { overlayFilling, FILL_PLACEHOLDER } = fillMod as typeof import('../../server/src/lib/field-fill-overlay')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const read = (rel: string) => JSON.parse(fs.readFileSync(`tests/mock-treg/fixtures/${rel}`, 'utf8'))
const find = normalizeTool(read('catalog/endpoints/treg.people.email.find.json'))!
const company = normalizeTool(read('catalog/endpoints/treg.companies.enrich.json'))!
const people = normalizeTool(read('catalog/endpoints/treg.people.search.json'))!

const parse = (body: Record<string, unknown> | { error: string }) =>
  'error' in body && typeof body.error === 'string' ? body : parseEnrichRunInput(body)

// Verified work email with the preset's default outputs.
const email = parse(agentRunBody({
  preset: 'verified_email', column_name: 'Work email', inputs: { full_name: 'Name', domain: { column: 'Website' } },
  email: { accept: 'balanced', guess: 'false' },
}, find, null, null))
check('the preset runs with its three default outputs', 'ok' in email
  && email.ok.outputs.map(o => o.key).join() === 'email,email_status,found_by')
check('a column name is a column input; {column} too', 'ok' in email
  && JSON.stringify(email.ok.inputs) === '{"full_name":{"column":"Name"},"domain":{"column":"Website"}}')
check('email settings come through ("false" reads as false)', 'ok' in email
  && email.ok.email?.accept === 'balanced' && email.ok.email.guess === false)
check('a new column runs every row in scope by default', 'ok' in email
  && email.ok.rows.mode === 'all' && email.ok.rows.status === 'any' && email.ok.rows.test === null)

// A waterfall's outputs by field, plus "found_by".
const fields = outputFields(company, null)
check('a waterfall offers its fields and found_by', fields.includes('found_by') && fields.length > 1)
const firstField = company.outputs[0].field
const co = parse(agentRunBody({
  column_name: 'Company', inputs: { domain: 'Website', country: { value: 'US' } },
  outputs: [{ field: firstField, column_name: 'X' }, { field: 'found_by', column_name: 'Found by' }],
  test: 'true', where: [{ column: 'Website', operator: 'not_empty' }], rows: 'any',
}, company, null, null))
check('outputs map fields to the catalog paths', 'ok' in co && co.ok.outputs[0].path === company.outputs[0].path
  && co.ok.outputs[1].key === 'found_by')
check('a fixed value is a value input', 'ok' in co && JSON.stringify(co.ok.inputs.country) === '{"value":"US"}')
check('test:"true" is a test of the first rows', 'ok' in co && co.ok.rows.test === 5)
check('where operators become conditions', 'ok' in co && co.ok.conditions[0]?.op === 'not_empty')

const noOutputs = agentRunBody({ column_name: 'C', inputs: { domain: 'Website' } }, company, null, null)
check('a tool without a preset needs outputs, and says which', 'error' in noOutputs
  && String(noOutputs.error).includes(firstField))
const unknown = agentRunBody({ column_name: 'C', outputs: [{ field: 'nope', column_name: 'N' }] }, company, null, null)
check('an unknown field is refused', 'error' in unknown && String(unknown.error).includes('no output "nope"'))
for (const v of ['yes', 1, 'TRUE']) {
  const r = agentRunBody({ column_name: 'C', test: v, outputs: [{ field: firstField, column_name: 'X' }] },
    company, null, null)
  check(`test: ${JSON.stringify(v)} is refused, never a full run`, 'error' in r)
}
check('flags read true/false and their text only',
  flagOf(true) === true && flagOf('false') === false && flagOf(undefined) === undefined && flagOf(0) === 'invalid')
const both = agentRunBody(
  { column_name: 'C', use_sheet_filter: true, outputs: [{ field: firstField, column_name: 'X' }] },
  company, [3, 4], 7)
check('target rows and the sheet filter together are refused', 'error' in both)
const picked = parse(agentRunBody({ column_name: 'C', outputs: [{ field: firstField, column_name: 'X' }] },
  company, [4, 3], 7))
check('target rows run as selected rows, fenced by the generation', 'ok' in picked
  && picked.ok.rows.mode === 'selected' && picked.ok.rows.rowIndexes?.join() === '3,4' && picked.ok.rowGeneration === 7)
const badOp = agentRunBody({ column_name: 'C', outputs: [{ field: firstField, column_name: 'X' }],
  where: [{ column: 'A', operator: 'gte', value: '1' }] }, company, null, null)
check('an operator the run can\'t apply is refused', 'error' in badOp)

// List jobs: fields from real results, so a test first.
const listArgs = { column_name: 'People', inputs: { company_domain: 'Website' } }
const noTest = agentRunBody(
  { ...listArgs, list: { new_sheet_name: 'People', provider: 'quickenrich' } }, people, null, null,
)
check('a list job without fields must be a test', 'error' in noTest && String(noTest.error).includes('test: true'))
const listTest = parse(agentRunBody({
  ...listArgs, test: true,
  list: { new_sheet_name: 'People', provider: 'quickenrich', results_per_row: 3, copy_columns: [{ from: 'Company' }] },
}, people, null, null))
check('a list test maps its destination, results per row and copies', 'ok' in listTest
  && JSON.stringify(listTest.ok.list?.dest) === '{"newSheetName":"People"}' && listTest.ok.list?.maxItems === 3
  && listTest.ok.list?.fields === null && listTest.ok.list?.copy[0].to === 'Company'
  && listTest.ok.outputs.length === 0)
const listFull = parse(agentRunBody({
  ...listArgs, add_to_column: true, rows: 'not_enriched',
  list: { destination_sheet_id: '6c5a7f7e-1f2b-4c3d-9e8f-0a1b2c3d4e5f', provider: 'quickenrich',
    fields: [{ path: '$.first_name', column_name: 'First name' }], dedupe_path: '$.first_name' },
}, people, null, null))
check('a full list run takes fields and a dedupe path', 'ok' in listFull
  && listFull.ok.list?.fields?.[0].columnName === 'First name' && listFull.ok.list?.dedupePath === '$.first_name'
  && listFull.ok.continueColumn && listFull.ok.rows.status === 'not_enriched')
const listOutputs = agentRunBody(
  { ...listArgs, test: true, outputs: [], list: { new_sheet_name: 'P' } }, people, null, null,
)
check('a list job takes no outputs', 'error' in listOutputs)
const twoDests = agentRunBody({ ...listArgs, test: true,
  list: { new_sheet_name: 'P', destination_sheet_id: 'x' } }, people, null, null)
check('a list job names one destination', 'error' in twoDests)

// The processing overlay on a column still filling.
const rows = [{ data: { A: '1', B: 'half' } }, { data: { A: '2' } }]
overlayFilling(rows, ['B'])
check('a filling column reads as processing on every row', rows.every(r => r.data.B === FILL_PLACEHOLDER))
const projected = [{ data: { A: '1' } }]
overlayFilling(projected, ['B'], ['A'])
check('a read of other columns leaves it out', !('B' in projected[0].data))

// Arguments Cubex doesn't know are refused at every level, never dropped.
check('a camelCase estimate is refused with the right name',
  String(unknownArgument({ estimateOnly: true })).includes('did you mean estimate_only?'))
check('a misspelled condition value is refused',
  !!unknownArgument({ where: [{ column: 'A', operator: 'eq', values: 'x' }] }))
check('a typo in a copied column is refused',
  !!unknownArgument({ list: { new_sheet_name: 'P', copy_columns: [{ from: 'Domain', To: 'Website' }] } }))
check('known arguments pass', unknownArgument({
  sheet_id: 's', tool_id: 't', where: [{ column: 'A', operator: 'empty' }],
  inputs: { domain: 'Website', country: { value: 'US' } },
  list: { new_sheet_name: 'P', fields: [{ path: '$.a', column_name: 'A' }] },
}) === null)
const blankValue = agentRunBody({ column_name: 'C', outputs: [{ field: firstField, column_name: 'X' }],
  where: [{ column: 'A', operator: 'contains' }] }, company, null, null)
check('a condition that decides needs a value (an empty contains would pass every row)', 'error' in blankValue)
const extraValue = agentRunBody({ column_name: 'C', outputs: [{ field: firstField, column_name: 'X' }],
  where: [{ column: 'A', operator: 'empty', value: 'x' }] }, company, null, null)
check('empty / not_empty take no value', 'error' in extraValue)

// Answers cut to an agent's budget: one pass, largest parts first, inside a big part.
const small = { output: { email: 'a@b.example' } }
check('a small answer is left whole', budgetAnswer(small, 1000).cut.length === 0)
const wide = Object.fromEntries(Array.from({ length: 9000 }, (_, i) => [`k${i}`, 'x'.repeat(500)]))
const t0 = Date.now()
const wideCut = budgetAnswer({ output: { name: 'Acme' }, raw: wide }, 32 * 1024)
const took = Date.now() - t0
check(`a 4.5 MB wide answer is cut fast (${took} ms)`, took < 500)
check('it keeps the small part and some of the wide one, under the budget',
  JSON.stringify(wideCut.value).length <= 32 * 1024 && (wideCut.value as any).output.name === 'Acme'
  && Object.keys((wideCut.value as any).raw).length > 10 && wideCut.cut.length === 1
  && /^\$\.raw\.\* \([\d,]+ of 9,000 keys left out\)$/.test(wideCut.cut[0]))
const list = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i, text: 'y'.repeat(100) })) }
const listCut = budgetAnswer(list, 4096)
check('a long list keeps its first items and names the tail it left out',
  (listCut.value as any).items[0].id === 0 && listCut.cut.length === 1 && /^\$\.items\[\d+:\]$/.test(listCut.cut[0])
  && JSON.stringify(listCut.value).length <= 4096)
check('nothing fits: null and "$"', budgetAnswer('z'.repeat(5000), 100).value === null)
let deep: unknown = 'x'.repeat(2000)
for (let i = 0; i < 2000; i++) deep = { d: deep, pad: 'p'.repeat(20) }
const t1 = Date.now()
const deepCut = budgetAnswer(deep, 1024)
check(`a hostile 2,000-deep answer is cut fast (${Date.now() - t1} ms), within budget`,
  Date.now() - t1 < 200 && JSON.stringify(deepCut.value).length <= 1024)

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('all agent enrichment checks passed')
