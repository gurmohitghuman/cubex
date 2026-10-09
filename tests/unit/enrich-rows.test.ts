// Which rows an enrichment run takes and what the column menu reruns, against
// a migrated throwaway DB: the status rules (seeding and the SQL count agree),
// the run-start and rerun parsers, a column's setup recalled from its run
// config, the enrich-status column type, and the spend card's sums.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import seedMod from '../../server/src/lib/enrich-seed'
import inputMod from '../../server/src/lib/enrich-run-input'
import recallMod from '../../server/src/lib/enrich-run-recall'
import countMod from '../../server/src/services/enrich-row-count'
import typesMod from '../../server/src/lib/column-types'
import spendMod from '../../server/src/services/enrich-spend'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { statusMatches } = seedMod as typeof import('../../server/src/lib/enrich-seed')
const { parseEnrichRunInput, parseRerunInput } = inputMod as typeof import('../../server/src/lib/enrich-run-input')
const { recallChoices, rerunInput } = recallMod as typeof import('../../server/src/lib/enrich-run-recall')
const { enrichRowCounts, countFor } = countMod as typeof import('../../server/src/services/enrich-row-count')
const { getColumnTypes } = typesMod as typeof import('../../server/src/lib/column-types')
const { enrichSpend, spendWindow } = spendMod as typeof import('../../server/src/services/enrich-spend')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

// --- Status rules ------------------------------------------------------------
const CELLS = ['', '  ', '✅ Found', '⏭️ Not found', '⏭️ Budget ran out', '❌ Bad input', '✅ Valid']
check('not enriched: only empty cells', CELLS.filter(c => statusMatches(c, 'not_enriched')).length === 2)
check('failed: only ❌', CELLS.filter(c => statusMatches(c, 'failed')).length === 1)
check('without a result: empty, ⏭️ and ❌', CELLS.filter(c => statusMatches(c, 'no_result')).length === 5)
check('any: every row', CELLS.every(c => statusMatches(c, 'any')))

// --- Parsers -------------------------------------------------------------------
const base = {
  toolId: 'treg.people.email.find', columnName: 'Work email', inputs: { full_name: { column: 'Name' } },
  outputs: [], rows: { mode: 'all' },
}
const rowsOf = (body: Record<string, unknown>) => {
  const p = parseEnrichRunInput({ ...base, ...body })
  return 'ok' in p ? p.ok.rows : p.error
}
check('a new column takes every row', (rowsOf({}) as { status: string }).status === 'any')
const statusOf = (body: Record<string, unknown>) => (rowsOf(body) as { status: string }).status
check('adding to a column takes rows not enriched yet', statusOf({ continueColumn: true }) === 'not_enriched')
const legacy = rowsOf({ rows: { mode: 'not_enriched' } }) as { mode: string; status: string }
check('the old not_enriched mode still parses', legacy.mode === 'all' && legacy.status === 'not_enriched')
check('failed rows need a column a run made', typeof rowsOf({ rows: { mode: 'all', status: 'failed' } }) === 'string')
check('again: every row of the column',
  statusOf({ continueColumn: true, rows: { mode: 'all', status: 'any' } }) === 'any')
const rerun = parseRerunInput({ column: 'Work email', mode: 'selected', status: 'any', rowIndexes: [3, 1, 3] })
check('a rerun of selected rows dedupes and sorts them', 'ok' in rerun && rerun.ok.rows.rowIndexes?.join() === '1,3')
check('a rerun needs a column', 'error' in parseRerunInput({ mode: 'all' }))
check('a rerun needs its rows by status (never assumed)', 'error' in parseRerunInput({ column: 'X', mode: 'all' }))
const quoted = parseRerunInput({ column: 'X', mode: 'all', status: 'any', spendLimitUsd: 0.48, rowGeneration: 3 })
check('a rerun keeps the quoted run limit and the row generation',
  'ok' in quoted && quoted.ok.spendLimitUsd === 0.48 && quoted.ok.rowGeneration === 3)
const estOnly = parseRerunInput({ column: 'X', mode: 'all', status: 'failed', estimateOnly: true })
check('estimate only is a flag', 'ok' in estOnly && estOnly.ok.estimateOnly)

// --- Recall ----------------------------------------------------------------------
const config = {
  requestConfig: {
    method: 'POST', url: 'x', headers: {}, body: JSON.stringify({ full_name: '{{Name}}', domain: 'acme.example' }),
  },
  responseMapping: [
    { columnName: 'Email', jsonPath: '$._cubex.email' }, { columnName: 'Found by', jsonPath: '$._cubex.found_by' },
    { columnName: 'Title', jsonPath: '$.output.title' },
  ],
  previewSize: 5,
  enrichment: {
    v: 1, toolId: 'treg.people.email.find', toolName: 'Verified work email', kind: 'waterfall',
    preset: 'verified_email',
    toolSnapshot: {}, providerNames: {}, route: { prefer: ['kitt', 'tomba'], exclude: ['wiza'], stopAtFirst: false },
    cleanDomains: true, fresh: true, maxCostPerRowUsd: 0.05, spendLimitUsd: 2,
    rows: { mode: 'all', status: 'any', test: 5, where: [{ column: 'Size', op: 'gt', value: '50' }] },
    email: {
      strategy: 'balanced', guess: false, pattern: 'flast', verifyTool: {}, verifyExclude: [], verifyKind: 'waterfall',
    },
  },
} as never
const c = recallChoices(config, 'Work email')
const wantInputs = { full_name: { column: 'Name' }, domain: { value: 'acme.example' } }
check('inputs: a column ref and a fixed value', JSON.stringify(c.inputs) === JSON.stringify(wantInputs))
check('providers: the order and the ones left out',
  c.providerOrder.join() === 'kitt,tomba' && c.skipProviders.join() === 'wiza')
check('email checks come back',
  c.email?.accept === 'balanced' && c.email.guess === false && c.email.pattern === 'flast')
check('outputs: Cubex keys and treg paths',
  c.outputs.map(o => o.key).join() === 'email,found_by,title' && c.outputs[2].path === '$.output.title')
check('the per-row cap and fresh stay; Only run if too',
  c.maxCostPerRowUsd === 0.05 && c.fresh && c.conditions.length === 1)
const again = rerunInput(c, { mode: 'all', status: 'failed', test: null, rowIndexes: null })
check('a rerun adds to the column with a new run limit',
  again.continueColumn && again.spendLimitUsd === null && again.rows.status === 'failed')

// --- Counts, column types and spend on a sheet ----------------------------------------
const uid = uuid(), tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'Leads')
db.prepare(`INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)`)
  .run(sheetId, tableId, uid, 'Sheet 1', JSON.stringify(['Name', 'Work email']))
CELLS.forEach((cell, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  .run(uuid(), sheetId, uid, i, JSON.stringify({ Name: `P${i}`, ...(cell ? { 'Work email': cell } : {}) })))
const counts = await enrichRowCounts(sheetId, uid, 'Work email', { mode: 'all', rowIndexes: null })
check('counts agree with the seeding rules',
  counts.total === 7 && counts.notEnriched === 2 && counts.noResult === 5 && counts.failed === 1)
check('countFor picks the bucket', countFor(counts, 'failed') === 1 && countFor(counts, 'any') === 7)
const sel = await enrichRowCounts(sheetId, uid, 'Work email', { mode: 'selected', rowIndexes: [0, 2, 5] })
check('selected rows count by status too', sel.total === 3 && sel.notEnriched === 1 && sel.failed === 1)
const fresh = await enrichRowCounts(sheetId, uid, null, { mode: 'all', rowIndexes: null })
check('no column: every row is not enriched yet', fresh.notEnriched === 7)

// The seeding check and the SQL count agree on odd blanks too (tabs, newlines,
// no-break spaces around a mark), and across many count slices.
const odd = ['\t', '\n', String.fromCharCode(0xa0), ' \t❌ x', '\n⏭️ Not found ', '✅ Found\t', 'x']
const oddSheet = uuid()
db.prepare(`INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)`)
  .run(oddSheet, tableId, uid, 'Odd', JSON.stringify(['S']))
const many = Array.from({ length: 45_000 }, (_, i) => odd[i % odd.length])
const insertRow = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  many.forEach((cell, i) => insertRow.run(uuid(), oddSheet, uid, i * 3, JSON.stringify({ S: cell })))
})()
const oddCounts = await enrichRowCounts(oddSheet, uid, 'S', { mode: 'all', rowIndexes: null })
const tally = (st: 'not_enriched' | 'no_result' | 'failed') => many.filter(c => statusMatches(c, st)).length
check('SQL count == seeding rule, with odd blanks and sparse row numbers over several slices',
  oddCounts.total === many.length && oddCounts.notEnriched === tally('not_enriched')
  && oddCounts.noResult === tally('no_result') && oddCounts.failed === tally('failed'))
// "Only run if" narrows the count with the seeding's own check, over several slices too.
const onlyIf = await enrichRowCounts(oddSheet, uid, 'S', {
  mode: 'all', rowIndexes: null, where: [{ column: 'S', op: 'contains', value: 'found' }],
})
const passing = many.filter(c => c.toLowerCase().includes('found'))
check('Only run if counts just the rows passing it, by status',
  onlyIf.total === passing.length && passing.length > 0
  && onlyIf.noResult === passing.filter(c => statusMatches(c, 'no_result')).length
  && onlyIf.notEnriched === passing.filter(c => statusMatches(c, 'not_enriched')).length)
const none = await enrichRowCounts(sheetId, uid, null, {
  mode: 'selected', rowIndexes: [0, 1], where: [{ column: 'Name', op: 'eq', value: 'P6' }],
})
check('a condition no selected row passes counts none', none.total === 0)

db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name) VALUES (?,?,?,?,?,?)`)
  .run(uuid(), sheetId, uid, JSON.stringify(config), 'completed', 'Work email')
db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name) VALUES (?,?,?,?,?,?)`)
  .run(uuid(), sheetId, uid, JSON.stringify({ requestConfig: {}, responseMapping: [] }), 'completed', 'Plain')
db.prepare(`INSERT INTO http_column_associations (id, sheet_id, user_id, master_column_name, extracted_column_name)
  VALUES (?,?,?,?,?)`).run(uuid(), sheetId, uid, 'Work email', 'Email')
const types = getColumnTypes(sheetId, uid)
check('an enrichment status column is enrich-status', types['Work email'] === 'enrich-status')
check('its outputs stay http-extracted, a plain HTTP column stays http-master',
  types.Email === 'http-extracted' && types.Plain === 'http-master')

const call = db.prepare(`INSERT INTO enrichment_calls
  (id, user_id, sheet_id, status_column, tool_id, attempt, cost_micro, created_at) VALUES (?,?,?,?,?,?,?,?)`)
const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
const old = new Date(Date.now() - 40 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
call.run(uuid(), uid, sheetId, 'Work email', 't', 'f1', 5000, now)
call.run(uuid(), uid, sheetId, 'Work email', 't', 'v1', null, now)
call.run(uuid(), uid, 'gone-sheet', 'Phone', 't', 't1', 2500, now)
call.run(uuid(), uid, sheetId, 'Work email', 't', 'f1', 9000, old)
const spend = await enrichSpend(uid, 30)
check('30 days: the total and calls skip older ones', Math.abs(spend.totalUsd - 0.0075) < 1e-9 && spend.calls === 3)
const top = spend.columns[0]
check('per column, the biggest first, with names',
  top.column === 'Work email' && top.tableName === 'Leads' && top.sheetName === 'Sheet 1' && top.calls === 2)
check('a deleted sheet has no names', spend.columns[1].sheetId === null && spend.columns[1].tableName === null)
check('90 days include the older call', Math.abs((await enrichSpend(uid, 90)).totalUsd - 0.0165) < 1e-9)
check('an unknown window reads as 30 days', spendWindow('abc') === 30 && spendWindow('7') === 7)

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall enrichment rows checks passed')
