// Open roles at the companies on a person's own sheet (lib/hiring/open-roles-input.ts, services/open-roles.ts,
// lib/enrich-request.ts) against the repo's mock treg, the job queue only recording (no search runs):
// - the ask parsed strictly (website column, titles as the index takes them, country, place, how recent, per company);
// - the run: the row's website as the one company, the roles as titles, a filter only when asked, kept roles with
//   the company row's own website cell as Domain and the run's day as First seen;
// - under the run's domain cleaning, a website cell becomes its domain, and one that cleans to nothing isn't searched
//   (with no company, the index would answer roles at any company); without cleaning, as before;
// - the estimate is free (only the free count is called, over the companies with a website) and makes nothing;
// - a start over the estimate's most is refused with the new estimate, nothing made; an agent's refusal makes
//   nothing either;
// - the start makes the Open roles sheet beside the sheet, the search column and the two lookups, and runs with the
//   estimate's most as its spend limit; a second start reuses all three, with the new day as First seen; a run still
//   going is refused;
// - names the person already uses are left alone (a number after ours); a hiring table's sheets are refused.
import assert from 'node:assert/strict'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('open-roles')
const { db, uid, ok, done, sheet } = kit
const { parseOpenRoles, openRolesInput, OPEN_ROLE_COLUMNS } = await import('../../server/src/lib/hiring/open-roles-input')
const { openRoles, openRolesSetup } = await import('../../server/src/services/open-roles')
const { buildRequest } = await import('../../server/src/lib/enrich-request')
const { inputTemplates } = await import('../../server/src/lib/enrich-run-config')
const { buildEnrichmentConfig } = await import('../../server/src/services/enrich-run-build')
const { dayIn } = await import('../../server/src/lib/ai-visibility/check')
const { OPEN_ROLES, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')
const TREG = process.env.TREG_BASE_URL!

const calls = async () => ((await (await fetch(`${TREG}/__mock/requests`)).json()) as Array<{ path: string }>)
  .map(r => r.path).filter(p => p.startsWith('/call/'))
const resetCalls = () => fetch(`${TREG}/__mock/reset`, { method: 'POST' })
const runsOn = (sid: string) => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ? AND setup_only = 0')
  .pluck().get(sid) as number
// The Open roles sheets made (the kit keeps every sheet in one table).
const rolesSheets = () => db.prepare(`SELECT name FROM sheets WHERE name LIKE 'Open roles%' AND trash_id IS NULL
  ORDER BY name`).pluck().all() as string[]
const today = () => dayIn(new Date().toISOString().replace('T', ' ').slice(0, 19), 'America/Toronto')
const columnsOf = (sid: string) => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
  .get(sid) as string) as string[]
const lookups = (sid: string) => db.prepare(`SELECT column_name, returns, match_column, source_column
  FROM lookup_columns WHERE sheet_id = ? ORDER BY column_name`).all(sid)
const newestConfig = (sid: string) => JSON.parse(db.prepare(`SELECT config FROM http_runs WHERE sheet_id = ?
  AND setup_only = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1`).pluck().get(sid) as string)
const parsed = (v: Record<string, unknown>) => {
  const p = parseOpenRoles(v)
  assert.ok(typeof p === 'object', String(p))
  return p
}

await ok('the ask is parsed strictly: a website column, the titles as the job index takes them, the filters', () => {
  const p = parsed({ websiteColumn: ' Website ', roles: ['SDR', '-BDR, Inbound', 'AE {{Website}}', 'SDR'] })
  assert.deepEqual(p, { websiteColumn: 'Website', roles: ['SDR', 'BDR Inbound', 'AE Website'], country: null,
    place: null, postedWithinDays: 30, perCompany: 10 })
  assert.deepEqual(parsed({ websiteColumn: 'W', roles: 'SDR\nAE', country: 'us', place: ' Austin ',
    postedWithinDays: '7', perCompany: 3 }), { websiteColumn: 'W', roles: ['SDR', 'AE'], country: 'US',
    place: 'Austin', postedWithinDays: 7, perCompany: 3 })
  assert.equal(parsed({ websiteColumn: 'W', roles: ['SDR'], postedWithinDays: null }).postedWithinDays, null)
  for (const [v, word] of [[{ roles: ['SDR'] }, 'websiteColumn'], [{ websiteColumn: 'W', roles: [] }, 'role title'],
    [{ websiteColumn: 'W', roles: ['SDR'], country: 'USA' }, 'country'],
    [{ websiteColumn: 'W', roles: ['SDR'], place: '{{W}}' }, 'place'],
    [{ websiteColumn: 'W', roles: ['SDR'], postedWithinDays: 0 }, 'postedWithinDays'],
    [{ websiteColumn: 'W', roles: ['SDR'], perCompany: 101 }, 'perCompany']] as const) {
    const out = parseOpenRoles(v)
    assert.ok(typeof out === 'string' && out.includes(word), `${JSON.stringify(v)}: ${out}`)
  }
  const snake = parseOpenRoles({ roles: ['SDR'], perCompany: 0 }, 'snake')
  assert.ok(typeof snake === 'string' && snake.includes('website_column'), String(snake))
})

const o = parsed({ websiteColumn: 'Website', roles: ['SDR', 'Account Executive'], country: 'US', place: 'Austin',
  postedWithinDays: 14, perCompany: 4 })

await ok('the run: the row\'s website as the one company, the roles as titles, the roles kept with the company\'s own '
  + 'website cell and the run\'s day', () => {
  const input = openRolesInput(o, 'dest-id', '2026-11-27', false)
  assert.equal(input.toolId, 'hirebase.jobs.search')
  assert.equal(input.cleanDomains, true)
  assert.equal(input.runIf, '{{Website}} is not empty')
  assert.deepEqual(input.inputs, {
    company_domains: { value: '["{{Website}}"]' }, job_titles: { value: '["SDR","Account Executive"]' },
    geo_locations: { value: '[{"country":"United States","city":"Austin"}]' }, days_ago: { value: '14' },
  })
  const l = input.list!
  assert.deepEqual([l.maxItems, l.keep, l.itemsPath, l.provider], [4, true, '$.jobs', null])
  assert.deepEqual(l.copy, [{ from: 'Website', to: R.domain }, { from: '', to: R.firstSeen, value: '2026-11-27' }])
  assert.ok(!l.fields!.some(f => f.columnName === R.domain), 'Domain is the copied cell, not the index\'s')
  assert.deepEqual(l.fields!.map(f => f.columnName), [R.title, R.company, R.team, R.location, R.posted, R.link])
  assert.equal(l.dedupePath, '$.application_link')
  const bare = openRolesInput({ ...o, country: null, place: null, postedWithinDays: null }, 'd', 'x', true)
  assert.deepEqual(Object.keys(bare.inputs), ['company_domains', 'job_titles'], 'a filter only when asked')
  assert.equal(bare.continueColumn, true)
  assert.deepEqual(OPEN_ROLE_COLUMNS, [R.title, R.company, R.domain, R.team, R.location, R.posted, R.link,
    R.firstSeen])
})

await ok('under the run\'s domain cleaning a website cell becomes its domain; one that cleans to nothing isn\'t '
  + 'searched; without cleaning, as before', async () => {
  const input = openRolesInput(o, '', '2026-11-27', false)
  const built = await buildEnrichmentConfig(input, ['Name', 'Website'], 10)
  assert.ok('ok' in built, JSON.stringify(built))
  const tool = built.ok.enrichment.toolSnapshot
  const templates = inputTemplates(built.ok)
  const req = (website: string, cleanDomains = true) => buildRequest(tool, templates, { Name: 'N', Website: website },
    { cleanDomains, columns: ['Name', 'Website'] })
  const body = (website: string) => {
    const r = req(website)
    assert.ok(r.ok, `${website}: ${JSON.stringify(r)}`)
    return JSON.parse(r.body!) as Record<string, unknown>
  }
  assert.deepEqual(body('https://www.Northwind-Labs.io/careers?x=1').company_domains, ['northwind-labs.io'])
  assert.deepEqual(body('bluefin-data.io, https://quillmark.io').company_domains, ['bluefin-data.io', 'quillmark.io'])
  assert.deepEqual(body('bluefin-data.io').job_titles, ['SDR', 'Account Executive'])
  for (const empty of ['https://', '   ', '']) {
    const r = req(empty)
    assert.ok(!r.ok && 'missing' in r && r.missing === 'company_domains', `"${empty}": ${JSON.stringify(r)}`)
  }
  // Without cleaning (a hiring table's own search): sent as written, and an empty list is left out as before.
  const raw = req('https://www.Northwind-Labs.io/', false)
  assert.ok(raw.ok, JSON.stringify(raw))
  assert.deepEqual(JSON.parse(raw.body!).company_domains, ['https://www.Northwind-Labs.io/'])
  const none = req('', false)
  assert.ok(none.ok && JSON.parse(none.body!).company_domains === undefined, JSON.stringify(none))
})

const COMPANIES = [
  { Name: 'Northwind', Website: 'https://northwind-labs.io' }, { Name: 'Nobody', Website: '' },
  { Name: 'Bluefin', Website: 'www.bluefin-data.io' }, { Name: 'Copperleaf', Website: 'copperleaf-systems.io/' },
]
const sid = sheet(COMPANIES, ['Name', 'Website'])
const ask = (more: Record<string, unknown> = {}) => openRoles(uid, sid, { ...o, estimateOnly: true, maxCostUsd: null,
  timeZone: 'America/Toronto', ...more })

let high = 0
await ok('the estimate: free (only the count is called, over the companies with a website), and nothing made',
  async () => {
  await resetCalls()
  const e = await ask()
  assert.ok('ok' in e && 'estimate' in e.ok, JSON.stringify(e))
  const est = e.ok.estimate
  assert.equal(est.companies, 4)
  assert.equal(est.rolesUpTo, 16)
  assert.ok(est.priceKnown && est.highUsd > 0, JSON.stringify(est))
  assert.equal(est.matches?.counted, 3, JSON.stringify(est.matches))
  assert.ok((est.matches?.about ?? 0) > 0, JSON.stringify(est.matches))
  assert.ok((await calls()).every(p => p.endsWith('.jobs.search.count')), (await calls()).join())
  high = est.highUsd
  assert.deepEqual(rolesSheets(), [])
  assert.equal(runsOn(sid), 0)
  assert.deepEqual(columnsOf(sid), ['Name', 'Website'])
})

await ok('a start over the most it was sent is refused with the new estimate, and an agent\'s refusal too: '
  + 'nothing made, nothing run', async () => {
  const over = await ask({ estimateOnly: false, maxCostUsd: high / 2 })
  assert.ok('fail' in over && over.fail === 'over_ceiling' && over.estimate?.highUsd === high, JSON.stringify(over))
  const none = await ask({ estimateOnly: false })
  assert.ok('fail' in none && none.fail === 'over_ceiling', JSON.stringify(none))
  const agent = await ask({ estimateOnly: false, maxCostUsd: high, refuse: () => 'Over your daily cap.' })
  assert.deepEqual(agent, { fail: 'forbidden', message: 'Over your daily cap.' })
  assert.deepEqual(rolesSheets(), [])
  assert.equal(runsOn(sid), 0)
})

let rolesSheet = ''
await ok('the start: the Open roles sheet beside, the search column, the two lookups, and the run with the estimate\'s '
  + 'most as its spend limit and the day as First seen', async () => {
  const s = await ask({ estimateOnly: false, maxCostUsd: high })
  assert.ok('ok' in s && 'started' in s.ok, JSON.stringify(s))
  const st = s.ok.started
  rolesSheet = st.rolesSheetId
  assert.deepEqual([st.column, st.rolesSheetName, st.lookups, st.lookupsLeft],
    [OPEN_ROLES.status, OPEN_ROLES.sheet, [OPEN_ROLES.count, OPEN_ROLES.titles], null])
  assert.deepEqual(rolesSheets(), ['Open roles'])
  assert.deepEqual(columnsOf(rolesSheet), OPEN_ROLE_COLUMNS)
  assert.deepEqual(columnsOf(sid), ['Name', 'Website', OPEN_ROLES.status, OPEN_ROLES.count, OPEN_ROLES.titles])
  assert.deepEqual(lookups(sid), [
    { column_name: OPEN_ROLES.count, returns: 'count', match_column: R.domain, source_column: 'Website' },
    { column_name: OPEN_ROLES.titles, returns: 'list', match_column: R.domain, source_column: 'Website' },
  ])
  const c = newestConfig(sid)
  assert.equal(runsOn(sid), 1)
  assert.equal(c.enrichment.toolId, 'hirebase.jobs.search')
  assert.equal(c.enrichment.list.destSheetId, rolesSheet)
  assert.equal(c.enrichment.list.keep, true)
  assert.deepEqual(c.enrichment.list.copy.filter((x: { to: string }) => x.to === R.firstSeen)
    .map((x: { value: string }) => x.value), [today()])
  assert.equal(c.enrichment.spendLimitUsd, high)
})

await ok('a run still going is refused; once it is over, a second start reuses the sheet, the column and the '
  + 'lookups, with the roles asked now and the day once', async () => {
  const going = await ask({ estimateOnly: false, maxCostUsd: high })
  assert.ok('fail' in going && going.fail === 'conflict' && going.message.includes('still searching'),
    JSON.stringify(going))
  await kit.idle(sid)
  db.prepare(`UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE sheet_id = ?`).run(sid)
  const s = await ask({ estimateOnly: false, maxCostUsd: high, roles: ['BDR'] })
  assert.ok('ok' in s && 'started' in s.ok, JSON.stringify(s))
  assert.deepEqual([s.ok.started.rolesSheetId, s.ok.started.column], [rolesSheet, OPEN_ROLES.status])
  assert.deepEqual(rolesSheets(), ['Open roles'])
  assert.equal(lookups(sid).length, 2)
  const c = newestConfig(sid)
  assert.deepEqual(c.enrichment.list.copy.filter((x: { to: string }) => x.to === R.firstSeen)
    .map((x: { value: string }) => x.value), [today()])
  assert.equal(inputTemplates(c).job_titles, '["BDR"]', 'the roles asked now')
  assert.equal(runsOn(sid), 2)
})

await ok('what the sheet\'s search was last run with reads back as asked (the country by its code); a sheet never '
  + 'searched has none', () => {
  assert.deepEqual(openRolesSetup(uid, sid), {
    options: { ...o, roles: ['BDR'] }, column: OPEN_ROLES.status, rolesSheetId: rolesSheet,
    rolesSheetName: OPEN_ROLES.sheet, going: true,
  })
  assert.equal(openRolesSetup(uid, sheet([{ Website: 'x.io' }], ['Website'])), null)
})

await ok('names the person already uses are left alone; a hiring table\'s sheets and a missing column are refused',
  async () => {
  const own = sheet([{ Website: 'quillmark.io', [OPEN_ROLES.status]: 'mine', [OPEN_ROLES.count]: '7' }],
    ['Website', OPEN_ROLES.status, OPEN_ROLES.count])
  const e = await openRoles(uid, own, { ...o, estimateOnly: true, maxCostUsd: null, timeZone: null })
  assert.ok('ok' in e && 'estimate' in e.ok, JSON.stringify(e))
  const s = await openRoles(uid, own, { ...o, estimateOnly: false, maxCostUsd: e.ok.estimate.highUsd, timeZone: null })
  assert.ok('ok' in s && 'started' in s.ok, JSON.stringify(s))
  assert.deepEqual([s.ok.started.column, s.ok.started.lookups],
    [`${OPEN_ROLES.status} 2`, [`${OPEN_ROLES.count} 2`, OPEN_ROLES.titles]])
  assert.deepEqual(rolesSheets(), ['Open roles', 'Open roles 2'], 'a free name in the table')
  const missing = await openRoles(uid, sid, { ...o, websiteColumn: 'Site', estimateOnly: true, maxCostUsd: null,
    timeZone: null })
  assert.ok('fail' in missing && missing.message.includes('"Site"'), JSON.stringify(missing))
  db.prepare(`INSERT INTO hiring_signals (id, user_id, table_id, companies_sheet_id, roles_sheet_id,
      searches_sheet_id, roles) VALUES ('h1', ?, (SELECT table_id FROM sheets WHERE id = ?), ?, NULL, NULL, '[]')`)
    .run(uid, own, own)
  const hiring = await openRoles(uid, own, { ...o, estimateOnly: true, maxCostUsd: null, timeZone: null })
  assert.ok('fail' in hiring && hiring.message.includes('hiring table'), JSON.stringify(hiring))
})

done()
