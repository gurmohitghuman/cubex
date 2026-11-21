// A hiring table made with description words, seniority and the rest (services/hiring-create.ts, hiring-check.ts,
// hiring-count.ts, job-count.ts, hiring-agent.ts) against the repo's mock treg, the job queue only recording (no
// search runs): its Searches sheet has a column per filter, filled as written, and its search runs the job index
// itself, reading each filter from its column; a row with no role title isn't searched or counted. The estimate's
// free count is sent each search's own request (no seniority, limit 0) and says it leaves seniority out; a count
// refused or not free means no count, never a failed estimate. Each search row's request carries its filters,
// edited cells included. A table without them is made as before.
import assert from 'node:assert/strict'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('hiring-filters-check')
const { db, uid, ok, done } = kit
const { parseHiringInput } = await import('../../server/src/lib/hiring/input')
const { createHiringTable } = await import('../../server/src/services/hiring-create')
const { estimateHiringCheck, searchColumnOf, startHiringCheck } = await import('../../server/src/services/hiring-check')
const { agentCheckHiring, agentCreateHiring } = await import('../../server/src/services/hiring-agent')
const { hiringFor } = await import('../../server/src/services/hiring-store')
const { newestColumnRun } = await import('../../server/src/services/enrich-column')
const { rowRequest } = await import('../../server/src/services/enrich-row')
const { getSheetColumns, parseRowData } = await import('../../server/src/lib/sql-helpers')
const { sheetColumnDescriptions } = await import('../../server/src/lib/column-descriptions')
const N = await import('../../server/src/lib/hiring/names')
const { FILTER_COLUMNS: F, SEARCH_COLUMNS: S } = N
const TREG = process.env.TREG_BASE_URL!

type Req = { path: string; body: string }
const counts = async () => ((await (await fetch(`${TREG}/__mock/requests`)).json()) as Req[])
  .filter(r => r.path === '/call/hirebase.jobs.search.count').map(r => JSON.parse(r.body))
const calls = async () => ((await (await fetch(`${TREG}/__mock/requests`)).json()) as Req[])
  .map(r => r.path).filter(p => p.startsWith('/call/'))
const reset = () => fetch(`${TREG}/__mock/reset`, { method: 'POST' })
const steer = (patch: object) => fetch(`${TREG}/__mock/state`, { method: 'POST', body: JSON.stringify(patch) })
const rowsOf = (sheetId: string) => (db.prepare('SELECT id, data FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .all(sheetId) as Array<{ id: string; data: string }>).map(r => ({ id: r.id, data: parseRowData(r.data) }))

const input = parseHiringInput({
  roles: ['SDR', 'Engineer, Backend'], country: 'US', place: 'Texas', postedWithinDays: 14, perSearch: 5,
  descriptionWords: 'Salesforce', leaveOutDescriptionWords: ['clearance'], leaveOutTitleWords: '-Senior',
  seniority: ['Senior', 'Executive'], employmentTypes: ['Full Time'], companies: 'northwind-labs.io, bluefin-data.io',
})
assert.ok(typeof input === 'object')
await reset()
const made = await createHiringTable(uid, input)
assert.ok('ok' in made, JSON.stringify(made))
const t = made.ok
const rec = () => hiringFor(uid, t.id)!

await ok('made: a column per filter, filled as written, the country by name; the job index itself; no call',
  async () => {
  assert.equal(t.provider, 'hirebase')
  assert.deepEqual(getSheetColumns(t.searchesSheetId, uid),
    [S.role, S.country, S.place, S.days, ...Object.values(F), S.status])
  assert.deepEqual(rowsOf(t.searchesSheetId).map(r => r.data), ['SDR', 'Engineer Backend'].map(role => ({
    [S.role]: role, [S.country]: 'United States', [S.place]: 'Texas', [S.days]: '14',
    [F.descriptionWords]: 'Salesforce', [F.leaveOutDescriptionWords]: 'clearance', [F.leaveOutTitleWords]: 'Senior',
    [F.seniority]: 'Senior, Executive', [F.employmentTypes]: 'Full Time',
    [F.companies]: 'northwind-labs.io, bluefin-data.io',
  })))
  const words = sheetColumnDescriptions(t.searchesSheetId, uid)
  assert.equal(words.get(F.descriptionWords), N.FILTER_COLUMN_WORDS[F.descriptionWords])
  assert.equal(words.get(S.country), 'A country, such as United States. Empty: any country.')
  const column = searchColumnOf(uid, rec())
  assert.equal(column, S.status)
  const e = newestColumnRun(t.searchesSheetId, uid, column!)!.config.enrichment
  assert.deepEqual([e.toolId, e.list?.provider, e.list?.itemsPath], [N.HIRING_DIRECT_TOOL_ID, null, '$.jobs'])
  assert.deepEqual((await calls()).filter(p => p.startsWith('/call/')), [])
})

await ok('each search row\'s request carries its filters, from its own cells, edited ones included', async () => {
  const config = newestColumnRun(t.searchesSheetId, uid, S.status)!.config
  const columns = getSheetColumns(t.searchesSheetId, uid)
  const [first, second] = rowsOf(t.searchesSheetId)
  const sent = (data: Record<string, string>) => {
    const r = rowRequest(config, { rowIndex: 0, rowId: null, data }, columns)
    assert.ok('built' in r, JSON.stringify(r))
    return JSON.parse(r.built.body!)
  }
  assert.deepEqual(sent(first.data), {
    job_titles: ['SDR', '-Senior'], keywords: ['Salesforce', '-clearance'],
    geo_locations: [{ country: 'United States', city: 'Texas' }], experience_levels: ['Senior', 'Executive'],
    job_types: ['Full Time'], company_domains: ['northwind-labs.io', 'bluefin-data.io'], days_ago: 14, limit: 5,
  })
  const edited = { ...second.data, [S.place]: '', [S.days]: '', [F.leaveOutTitleWords]: 'intern, -lead',
    [F.descriptionWords]: '', [F.leaveOutDescriptionWords]: '', [F.seniority]: '', [F.companies]: '' }
  assert.deepEqual(sent(edited), { job_titles: ['Engineer Backend', '-intern', '-lead'],
    geo_locations: [{ country: 'United States' }], job_types: ['Full Time'], limit: 5 })
})

const blank = crypto.randomUUID()
await ok('the estimate: free; the count sent each search\'s own request but seniority, and says so', async () => {
  // A row with no role title: not searched, not counted.
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, 99, ?)').run(
    blank, t.searchesSheetId, uid, JSON.stringify({ [F.employmentTypes]: 'Contract' }))
  await reset()
  const e = await estimateHiringCheck(uid, rec())
  assert.ok(!('fail' in e), JSON.stringify(e))
  assert.equal(e.estimate.searches, 2, 'the row with no title is left out')
  assert.equal(e.estimate.rolesUpTo, 10)
  assert.equal(e.plan.provider, 'hirebase')
  assert.ok((await calls()).every(p => p === '/call/hirebase.jobs.search.count'), (await calls()).join())
  const bodies = await counts()
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0], { job_titles: ['SDR', '-Senior'], keywords: ['Salesforce', '-clearance'],
    geo_locations: [{ country: 'United States', city: 'Texas' }], job_types: ['Full Time'],
    company_domains: ['northwind-labs.io', 'bluefin-data.io'], days_ago: 14, limit: 0 })
  // The mock counts the share of its 10 roles each search's filters keep, seniority aside (120 each without them).
  assert.deepEqual(e.estimate.matches, { about: 36, counted: 2, capped: false, leftOut: ['seniority'] })
  const agent = await agentCheckHiring(uid, 'token', t.id, { estimateOnly: true })
  assert.ok('ok' in agent)
  assert.equal((agent.ok.matches as { note: string }).note, 'The job index\'s free count. It doesn\'t take '
    + 'seniority, so it counts roles at every level and reads higher.')
})

await ok('a count refused for a field it doesn\'t take: no count, the estimate as before', async () => {
  await reset()
  await steer({ jobCountRefuses: ['job_types'] })
  const e = await estimateHiringCheck(uid, rec())
  assert.ok(!('fail' in e), JSON.stringify(e))
  assert.equal(e.estimate.matches, null)
  assert.equal(e.estimate.searches, 2)
  await reset()
})

await ok('the check: one run of the job index on the rows with a title, the estimate\'s most its limit', async () => {
  const e = await estimateHiringCheck(uid, rec())
  assert.ok(!('fail' in e))
  const out = await startHiringCheck(uid, rec(), { maxCostUsd: e.estimate.highUsd })
  assert.ok('ok' in out, JSON.stringify(out))
  const config = JSON.parse(db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(out.ok.runId) as string)
  assert.equal(config.enrichment.toolId, N.HIRING_DIRECT_TOOL_ID)
  assert.equal(config.runIf, '{{Role title}} is not empty')
  assert.equal(config.enrichment.spendLimitUsd, e.estimate.highUsd)
})

await ok('/api/v1 and MCP: the same names snake_case, answered back; a refusal names the field', async () => {
  const a = await agentCreateHiring(uid, { roles: ['AE'], seniority: 'mid', companies: ['ramp.com'] })
  assert.ok('ok' in a, JSON.stringify(a))
  assert.deepEqual([a.ok.seniority, a.ok.companies, a.ok.description_words], [['Mid-Level'], ['ramp.com'], []])
  const b = await agentCreateHiring(uid, { roles: ['AE'] })
  assert.ok('ok' in b)
  assert.equal('seniority' in b.ok, false, 'none: as before')
  assert.equal(hiringFor(uid, b.ok.id) && searchColumnOf(uid, hiringFor(uid, b.ok.id)!), S.status)
  assert.deepEqual(await agentCreateHiring(uid, { roles: ['AE'], employment_types: ['Gig'] }), { fail: 'bad_request',
    message: 'employment_types takes Full Time, Part Time, Contract, Internship (got "Gig").' })
})

kit.stop()
done()
