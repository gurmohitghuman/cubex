// The drawer's "Add results as rows" (client/src/components/enrich-modal/
// list-draft.ts): Set up's defaults for a list job (a new sheet named after
// the list, treg's first provider that can search the inputs, the input
// columns copied), the run request, fields picked from real results (and
// joined with later ones, keeping the user's ticks and names), and what stops
// a test or a full run. Pure: no DB, no network. Value imports are relative.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import toolMod from '../../server/src/lib/enrich-tool'
import { buildSetup } from '../../client/src/components/enrich-modal/setup-defaults'
import { runRequest } from '../../client/src/components/enrich-modal/run-request'
import { emptyDraft } from '../../client/src/components/enrich-modal/draft'
import {
  buildListDraft, destProblem, fieldPicks, fieldsProblem, listProblem, listRequest, mergePicks, perRowRange,
} from '../../client/src/components/enrich-modal/list-draft'
const { normalizeTool } = toolMod as typeof import('../../server/src/lib/enrich-tool')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const here = path.dirname(fileURLToPath(import.meta.url))
const detail = JSON.parse(fs.readFileSync(
  path.join(here, '../mock-treg/fixtures/catalog/endpoints/treg.people.search.json'), 'utf8'))
const tool: any = { ...normalizeTool(detail), addsRows: true }
const card: any = { id: tool.id, title: 'People at a company', kind: 'waterfall', price: tool.price, addsRows: true }
const columns = ['Name', 'Company', 'Website']
const sheets = [{ id: 's-people', name: 'People' }]

// --- Defaults ----------------------------------------------------------------
const built = buildSetup(card, tool, columns, null, sheets)
check('a list job has no outputs, and a list part', (built.outputs ?? []).length === 0 && !!built.list)
const list = built.list!
check('a new sheet named after the list, clear of the table\'s names',
  list.dest.kind === 'new' && list.dest.name === 'People 2')
check('the domain input is matched and its column copied',
  built.bindings?.company_domain?.kind === 'column' && list.copy.join() === 'Website')
check("treg's first provider that can search a domain", list.provider === 'quickenrich')
check('ten results per row, no fields yet', list.maxItems === 10 && list.fields === null)

// --- Requests ------------------------------------------------------------------
const draft: any = { ...emptyDraft(), card, columnName: 'People', bindings: built.bindings, list }
const req = runRequest(draft, { mode: 'all', selectedRows: [], test: true, order: [] })!
check('the run request sends the list part and no outputs',
  req.outputs.length === 0 && (req.list as any).dest.newSheetName === 'People 2' && req.list!.fields === null
  && req.list!.copy[0].from === 'Website' && req.list!.copy[0].to === 'Website')

// --- Fields from results -------------------------------------------------------------
const found = [
  { path: '$.first_name', label: 'first_name', filled: 3, sample: 'Ada' },
  { path: '$.employee_linkedin', label: 'employee_linkedin', filled: 3, sample: 'https://x' },
  { path: '$.home_page_email', label: 'home_page_email', filled: 0, sample: '' },
]
const picks = fieldPicks(found, null, list.copy)
check('filled fields start ticked, empty ones not, under readable names',
  picks[0].enabled && picks[0].columnName === 'First name' && picks[1].columnName === 'Employee LinkedIn'
  && !picks[2].enabled)
const edited = picks.map(p => (p.path === '$.first_name' ? { ...p, columnName: 'Given name' } : p))
const merged = mergePicks(edited, [...found, { path: '$.city', label: 'city', filled: 2, sample: 'Springfield' }],
  null, list.copy)
check('later results join in unticked; ticks and names stay',
  merged.length === 4 && merged[0].columnName === 'Given name' && !merged[3].enabled)
const kept = fieldPicks(found, [{ path: '$.employee_linkedin', columnName: 'LinkedIn' }], [])
check('Edit: kept fields ticked under their names, the rest offered',
  !kept[0].enabled && kept[1].enabled && kept[1].columnName === 'LinkedIn')
const withFields = { ...list, fields: picks, dedupePath: '$.employee_linkedin' }
const sent = listRequest(withFields)
check('the request sends the ticked fields and the duplicate check',
  sent.fields!.length === 2 && sent.dedupePath === '$.employee_linkedin')
check('a duplicate check on a field not kept is dropped',
  listRequest({ ...withFields, dedupePath: '$.home_page_email' }).dedupePath === null)

// --- What stops a run ----------------------------------------------------------------
const given = new Set(['company_domain'])
check('a test may run before fields are picked', listProblem(list, tool, given, sheets, true) === null)
check('a full run needs them', /Run on a few rows first/.test(listProblem(list, tool, given, sheets, false) ?? ''))
check('a taken sheet name is caught in place',
  /already exists/.test(destProblem({ ...list, dest: { kind: 'new', name: 'people' } }, sheets) ?? ''))
check('a deleted destination is caught',
  /deleted/.test(destProblem({ ...list, dest: { kind: 'sheet', sheetId: 'gone' } }, sheets) ?? ''))
check('results per row stay 1 to 100',
  /1 to 100/.test(listProblem({ ...list, maxItems: 0 }, tool, given, sheets, true) ?? ''))
const ownLimit = (max: number) => [...tool.inputs.filter((i: { name: string }) => i.name !== 'limit'),
  { name: 'limit', type: 'integer', min: 1, max }]
const paged = { ...tool, kind: 'single', inputs: ownLimit(25) }
check("a tool's own limit range narrows results per row (and the first draft keeps inside it)",
  perRowRange(paged).max === 25
  && /1 to 25/.test(listProblem({ ...list, maxItems: 30 }, paged, given, sheets, true) ?? '')
  && buildListDraft({ ...paged, inputs: ownLimit(5) }, {}, [], sheets).maxItems === 5)
check("a provider that can't search these inputs is refused",
  /can't search/.test(listProblem({ ...list, provider: 'quickenrich' }, tool, new Set(['q']), sheets, true) ?? ''))
check('two new columns with one name are caught', /would be named Website/.test(listProblem({
  ...withFields, fields: picks.map(p => ({ ...p, columnName: 'Website' })),
}, tool, given, sheets, false) ?? ''))
check('"skip" ticked with no field (or an unticked one) waits for the field',
  /tells results apart/.test(fieldsProblem({ ...withFields, dedupePath: '' }) ?? '')
  && /tells results apart/.test(fieldsProblem({ ...withFields, dedupePath: '$.home_page_email' }) ?? '')
  && fieldsProblem(withFields) === null)
check('results per row cleared (NaN) is caught',
  /1 to 100/.test(listProblem({ ...list, maxItems: NaN }, tool, given, sheets, true) ?? ''))
check('buildListDraft without inputs picks no provider that cannot search',
  buildListDraft(tool, {}, columns, []).provider === null)

if (failures) { console.error(`\n${failures} failed`); process.exit(1) }
console.log('\nall list client checks passed')
