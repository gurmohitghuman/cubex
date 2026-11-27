// A tool billed per result is priced at the results a call asks for, as treg holds them: its catalog's reserve rule
// (cost.reserve.rows: the input that sets how many, its default and its most) read through the catalog, a call priced
// at the value sent, at the tool's default when none is sent, and at its most when a column sets it (it can differ
// by row) or the rule is silent. Before, every such call was priced as 20 results: Findymail's people search (1 by
// default, at most 3) showed $1.98 for 5 rows where the most is $0.099, and hirebase's job search (10 by default)
// twice its default. A tool whose catalog has no rule keeps 20. The same count everywhere: a start (a list job too,
// whose dial isn't `limit`), a waterfall step, and the drawer's estimate given the dial's value; and a max per row
// under what one call holds, when the count is known, is refused (treg would turn down every row).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('enrich-reserve')
const { ok, done } = kit
const { normalizeTool } = await import('../../server/src/lib/enrich-tool')
const { defaultMaxCostPerRow, dialOf, knownCallHold, reservedRows } =
  await import('../../server/src/lib/enrich-estimate')
const { getTool } = await import('../../server/src/services/enrich-catalog')
const { buildEnrichmentConfig } = await import('../../server/src/services/enrich-run-build')
const { estimateEnrichment } = await import('../../server/src/services/enrich-setup')
const { parseEnrichRunInput } = await import('../../server/src/lib/enrich-run-input')
const { parseEstimateInput, fixedInputs } = await import('../../server/src/lib/enrich-estimate-input')
const { stepDialRows } = await import('../../server/src/services/waterfall-build-enrich')

const detail = (id: string) =>
  JSON.parse(fs.readFileSync(`tests/mock-treg/fixtures/catalog/endpoints/${id}.json`, 'utf8'))
// Findymail's people search as treg's catalog lists it (2026-11-27): $0.0198 a person, count 1 by default, 3 at most.
const findymailWith = (reserve: unknown) => normalizeTool({
  endpoint: { id: 'findymail.search.employees', provider: 'findymail', kind: 'data', method: 'POST',
    cost: { type: 'per_result', usd: 0.0198, reserve },
    input: { body: { website: { type: 'string', required: true }, job_titles: { type: 'array', required: true },
      count: { type: 'integer' } } } },
  example_response: [{ name: 'Grace Hopper', jobTitle: 'Head of Engineering' }],
})!
const findymail = findymailWith({ rows: { param: 'body.count', default: { value: 1 }, max: 3 } })

await ok('the rule is read: its input by name, its default and its most; none for a tool without one', () => {
  assert.deepEqual(findymail.price.reserve, { input: 'count', default: 1, max: 3 })
  assert.deepEqual(normalizeTool(detail('hirebase.jobs.search'))!.price.reserve,
    { input: 'limit', default: 10, max: 100 })
  assert.equal(normalizeTool(detail('treg.people.email.find'))!.price.reserve ?? null, null)
})

await ok('a call is priced at the results it asks for: sent, else the default, never past the most', () => {
  assert.equal(defaultMaxCostPerRow(findymail), 0.0198)
  assert.equal(defaultMaxCostPerRow(findymail, { limit: 2 }), 0.0396)
  assert.equal(defaultMaxCostPerRow(findymail, { limit: 5 }), 0.0594)
  const ruleless = { ...findymail, price: { ...findymail.price, reserve: null } }
  assert.equal(defaultMaxCostPerRow(ruleless), 0.396, 'no rule: 20 results, as before')
})

await ok('where the rule is silent: no readable default prices at its most; no most, a value as sent', () => {
  const noDefault = findymailWith({ rows: { param: 'body.count', default: { value: 'one' }, max: 3 } })
  assert.deepEqual(noDefault.price.reserve, { input: 'count', default: null, max: 3 })
  assert.equal(defaultMaxCostPerRow(noDefault), 0.0594)
  const noMost = findymailWith({ rows: { param: 'body.count', default: { value: 1 } } })
  assert.equal(defaultMaxCostPerRow(noMost, { limit: reservedRows(noMost, '150') }), 2.97, 'not cut at 100')
  assert.equal(reservedRows(noMost, '{{Count}}'), 100, 'a column with no most: 100')
})

await ok('the dial as sent: a whole number as it is; a column, 0 or other text at the most; else the default', () => {
  assert.equal(reservedRows(findymail, '2'), 2)
  assert.equal(reservedRows(findymail, ' 2 '), 2)
  assert.equal(reservedRows(findymail, '{{Count}}'), 3)
  assert.equal(reservedRows(findymail, '0'), 3)
  assert.equal(reservedRows(findymail, 'two'), 3)
  assert.equal(reservedRows(findymail, undefined), null)
  assert.equal(reservedRows({ ...findymail, price: { ...findymail.price, reserve: null } }, '2'), null)
  // An own input only: a dial named like an Object method isn't read off the prototype.
  const odd = findymailWith({ rows: { param: 'body.toString', default: { value: 1 }, max: 3 } })
  assert.equal(dialOf(odd, {}), undefined)
  assert.equal(dialOf(findymail, { count: '2' }), '2')
})

await ok('what one call holds is known for a value or none sent, not for a column', () => {
  assert.equal(knownCallHold(findymail, '3', null), 0.0594)
  assert.equal(knownCallHold(findymail, undefined, null), 0.0198)
  assert.equal(knownCallHold(findymail, '{{Count}}', null), null)
  assert.equal(knownCallHold(findymail, undefined, 5), 0.0594, 'a list job\'s results per row, within the most')
  assert.equal(knownCallHold({ ...findymail, price: { ...findymail.price, reserve: null } }, '3', null), null)
  // Nothing sent and no readable default: what treg holds isn't known, so no start is refused on a guess.
  const noDefault = findymailWith({ rows: { param: 'body.count', default: { value: 'one' }, max: 3 } })
  assert.equal(knownCallHold(noDefault, undefined, null), null)
  assert.equal(knownCallHold(noDefault, '2', null), 0.0396)
})

await ok('a waterfall step: a fixed value as it is, a waterfall input at the most, not given the default', () => {
  assert.equal(stepDialRows(findymail, { count: { value: '2' }, website: 'Domain' }, ['count', 'website']), 2)
  assert.equal(stepDialRows(findymail, { count: 'How many' }, ['count']), 3)
  assert.equal(stepDialRows(findymail, { count: 'How many' }, []), null, 'an input no column fills: not sent')
  assert.equal(stepDialRows(findymail, { website: 'Domain' }, ['website']), null)
})

type Inputs = Record<string, { column: string } | { value: string }>
const LIST = { dest: { newSheetName: 'People' }, maxItems: 3, fields: null, copy: [] }
async function start(toolId: string, inputs: Inputs, more: Record<string, unknown> = {}) {
  const parsed = parseEnrichRunInput({ toolId, columnName: 'Found', inputs, rows: { mode: 'all', status: 'any' },
    outputs: [], ...more })
  assert.ok('ok' in parsed, JSON.stringify(parsed))
  return buildEnrichmentConfig(parsed.ok, ['Domain', 'How many'], 10)
}
const capOf = async (...a: Parameters<typeof start>) => {
  const built = await start(...a)
  assert.ok('ok' in built, JSON.stringify(built))
  return built.ok.enrichment.maxCostPerRowUsd
}
const hirebaseOut = { outputs: [{ key: 'title', path: '$.jobs[0].job_title', columnName: 'First job' }] }

await ok('through the catalog: the rule survives it, and a start\'s per-row most follows the dial', async () => {
  const tool = await getTool('hirebase.jobs.search')
  assert.ok('ok' in tool, JSON.stringify(tool))
  assert.deepEqual(tool.ok.price.reserve, { input: 'limit', default: 10, max: 100 })
  const domains = { company_domains: { column: 'Domain' } }
  assert.equal(await capOf('hirebase.jobs.search', domains, hirebaseOut), 0.015, 'not sent: 10 jobs')
  assert.equal(await capOf('hirebase.jobs.search', { ...domains, limit: { value: '4' } }, hirebaseOut), 0.006)
  assert.equal(await capOf('hirebase.jobs.search', { ...domains, limit: { column: 'How many' } }, hirebaseOut), 0.15,
    'a column: 100 jobs at most')
})

await ok('a list job whose dial isn\'t limit is priced at the dial as sent, not the default', async () => {
  const base: Inputs = { website: { column: 'Domain' }, job_titles: { value: '["VP Sales"]' } }
  const list = { list: LIST }
  assert.equal(await capOf('findymail.search.employees', { ...base, count: { value: '3' } }, list), 0.0594)
  assert.equal(await capOf('findymail.search.employees', base, list), 0.0198, 'not sent: its default, 1')
  assert.equal(await capOf('findymail.search.employees', { ...base, count: { column: 'How many' } }, list), 0.0594)
  // A list job on hirebase still sends its results per row as limit.
  assert.equal(await capOf('hirebase.jobs.search', { company_domains: { column: 'Domain' } },
    { list: { ...LIST, maxItems: 4 } }), 0.006)
})

await ok('a max per row under what one call holds is refused when the count is known, kept for a column', async () => {
  const domains = { company_domains: { column: 'Domain' } }
  const low = await start('hirebase.jobs.search', { ...domains, limit: { value: '10' } },
    { ...hirebaseOut, maxCostPerRowUsd: 0.006 })
  assert.ok('fail' in low && /max per row \(\$0\.006\) is under what one call holds at treg \(\$0\.015\)/
    .test(low.message), JSON.stringify(low))
  assert.equal(await capOf('hirebase.jobs.search', { ...domains, limit: { value: '10' } },
    { ...hirebaseOut, maxCostPerRowUsd: 0.015 }), 0.015)
  assert.equal(await capOf('hirebase.jobs.search', { ...domains, limit: { column: 'How many' } },
    { ...hirebaseOut, maxCostPerRowUsd: 0.001 }), 0.001, 'a column: rows that ask for little can run')
  // A saved one-person most with count raised to 3 (a Buyer search edited): refused, in plain words.
  const raised = await start('findymail.search.employees', { website: { column: 'Domain' },
    job_titles: { value: '["VP Sales"]' }, count: { value: '3' } }, { list: LIST, maxCostPerRowUsd: 0.0198 })
  assert.ok('fail' in raised && /\(\$0\.0594\)/.test(raised.message), JSON.stringify(raised))
})

const est = async (toolId: string, given: string[] | null, fixed: Record<string, string> = {}) => {
  const out = await estimateEnrichment(kit.uid, { toolId, rows: 10, preset: null,
    maxCostPerRowUsd: null, limit: null, list: null, given, skip: [], order: [], stopAtFirst: false, fixed })
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok.defaultMaxCostPerRowUsd
}

await ok('the drawer\'s estimate: the dial\'s value as sent, a column at its most, unmapped its default', async () => {
  assert.equal(await est('hirebase.jobs.search', ['company_domains']), 0.015)
  assert.equal(await est('hirebase.jobs.search', ['company_domains', 'limit']), 0.15)
  assert.equal(await est('hirebase.jobs.search', ['company_domains', 'limit'], { limit: '4' }), 0.006)
  const fm = ['count', 'job_titles', 'website']
  assert.equal(await est('findymail.search.employees', fm, { count: '1', job_titles: '["VP Sales"]' }), 0.0198)
  assert.equal(await est('findymail.search.employees', fm), 0.0594)
  assert.equal(await est('findymail.search.employees', null), 0.0594, 'inputs not known: the most')
})

await ok('the estimate request takes the fixed inputs; a saved setup\'s values are read the same way', () => {
  const body = { toolId: 'hirebase.jobs.search', rows: 3, given: ['limit'], fixed: { limit: '4' } }
  const parsed = parseEstimateInput(body)
  assert.ok('ok' in parsed && parsed.ok.fixed.limit === '4', JSON.stringify(parsed))
  assert.ok('ok' in parseEstimateInput({ ...body, fixed: undefined }))
  for (const fixed of [['4'], { limit: 4 }, { limit: 'x'.repeat(1001) }, { 'bad name': '4' }]) {
    assert.ok('error' in parseEstimateInput({ ...body, fixed }), JSON.stringify(fixed))
  }
  assert.deepEqual(fixedInputs({ limit: { value: '4' }, company_domains: { column: 'Domain' } }), { limit: '4' })
})

done()
