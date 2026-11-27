// A tool billed per result is priced at the results a call asks for, as treg holds them: its catalog's reserve rule
// (cost.reserve.rows: the input that sets how many, its default and its most) read through the catalog, a call priced
// at the value sent, at the tool's default when none is sent, and at its most when a column sets it (it can differ
// by row). Before, every such call was priced as 20 results: Findymail's people search (1 by default, at most 3)
// showed $1.98 for 5 rows where the most is $0.099, and hirebase's job search (10 by default) twice its most. A tool
// whose catalog has no rule keeps 20.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('enrich-reserve')
const { ok, done } = kit
const { normalizeTool } = await import('../../server/src/lib/enrich-tool')
const { defaultMaxCostPerRow, reservedRows } = await import('../../server/src/lib/enrich-estimate')
const { getTool } = await import('../../server/src/services/enrich-catalog')
const { buildEnrichmentConfig } = await import('../../server/src/services/enrich-run-build')
const { estimateEnrichment } = await import('../../server/src/services/enrich-setup')
const { parseEnrichRunInput } = await import('../../server/src/lib/enrich-run-input')

const detail = (id: string) =>
  JSON.parse(fs.readFileSync(`tests/mock-treg/fixtures/catalog/endpoints/${id}.json`, 'utf8'))
// Findymail's people search as treg's catalog lists it (2026-11-27): $0.0198 a person, count 1 by default, 3 at most.
const findymail = normalizeTool({
  endpoint: { id: 'findymail.search.employees', provider: 'findymail', kind: 'data', method: 'POST',
    cost: { type: 'per_result', usd: 0.0198,
      reserve: { rows: { param: 'body.count', default: { value: 1 }, max: 3 } } },
    input: { body: { website: { type: 'string', required: true }, job_titles: { type: 'array', required: true },
      count: { type: 'integer' } } } },
  example_response: [{ name: 'Grace Hopper', jobTitle: 'Head of Engineering' }],
})!

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

await ok('the dial as sent: a number as it is, a column at the most, not sent the default', () => {
  assert.equal(reservedRows(findymail, '2'), 2)
  assert.equal(reservedRows(findymail, '{{Count}}'), 3)
  assert.equal(reservedRows(findymail, undefined), null)
  assert.equal(reservedRows({ ...findymail, price: { ...findymail.price, reserve: null } }, '2'), null)
})

await ok('through the catalog: the rule survives it, and a start\'s per-row most follows the dial', async () => {
  const tool = await getTool('hirebase.jobs.search')
  assert.ok('ok' in tool, JSON.stringify(tool))
  assert.deepEqual(tool.ok.price.reserve, { input: 'limit', default: 10, max: 100 })
  const start = async (inputs: Record<string, unknown>) => {
    const parsed = parseEnrichRunInput({ toolId: 'hirebase.jobs.search', columnName: 'Jobs', inputs,
      outputs: [{ key: 'title', path: '$.jobs[0].job_title', columnName: 'First job' }],
      rows: { mode: 'all', status: 'any' } })
    assert.ok('ok' in parsed, JSON.stringify(parsed))
    const built = await buildEnrichmentConfig(parsed.ok, ['Domain', 'How many'], 10)
    assert.ok('ok' in built, JSON.stringify(built))
    return built.ok.enrichment.maxCostPerRowUsd
  }
  const domains = { company_domains: { column: 'Domain' } }
  assert.equal(await start(domains), 0.015, 'not sent: 10 jobs')
  assert.equal(await start({ ...domains, limit: { value: '4' } }), 0.006)
  assert.equal(await start({ ...domains, limit: { column: 'How many' } }), 0.15, 'a column: 100 jobs at most')
})

await ok('the drawer\'s estimate: the dial mapped counts its most, not mapped its default', async () => {
  const est = async (given: string[]) => {
    const out = await estimateEnrichment(kit.uid, { toolId: 'hirebase.jobs.search', rows: 10, preset: null,
      maxCostPerRowUsd: null, limit: null, list: null, given, skip: [], order: [], stopAtFirst: false })
    assert.ok('ok' in out, JSON.stringify(out))
    return out.ok.defaultMaxCostPerRowUsd
  }
  assert.equal(await est(['company_domains']), 0.015)
  assert.equal(await est(['company_domains', 'limit']), 0.15)
})

done()
