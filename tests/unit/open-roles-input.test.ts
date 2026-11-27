// Open roles' ask and the request each company row makes (lib/hiring/open-roles-input.ts, lib/enrich-request.ts,
// lib/enrich-list.ts), against the repo's mock treg, the job queue only recording (no search runs), split from
// open-roles.test.ts:
// - the ask parsed strictly (website column, titles as the index takes them, country, place, how recent, per company);
// - Cubex's own copies (the website as its domain, the day a row is found), taken back from an edit in the app;
// - the run: the row's website as the one company, the roles as titles, a filter only when asked, kept roles with
//   the company's website as its domain as Domain and the day each is found as First seen;
// - under the run's domain cleaning, a website cell becomes its domain, and one that cleans to nothing isn't searched
//   (with no company, the index would answer roles at any company); without cleaning, as before.
import assert from 'node:assert/strict'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('open-roles-input')
const { db, uid, ok, done, sheet } = kit
const { parseOpenRoles, openRolesInput, openRolesCopies, OPEN_ROLE_COLUMNS } =
  await import('../../server/src/lib/hiring/open-roles-input')
const { openRoles } = await import('../../server/src/services/open-roles')
const { buildRequest } = await import('../../server/src/lib/enrich-request')
const { inputTemplates } = await import('../../server/src/lib/enrich-run-config')
const { copyValues } = await import('../../server/src/lib/enrich-list')
const { parseListInput } = await import('../../server/src/lib/enrich-list-input')
const { buildEnrichmentConfig } = await import('../../server/src/services/enrich-run-build')
const { dayIn } = await import('../../server/src/lib/ai-visibility/check')
const { HIRING_DIRECT_TOOL_ID, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')

const today = () => dayIn(new Date().toISOString().replace('T', ' ').slice(0, 19), 'America/Toronto')
const cleans = (sid: string) => db.prepare(`SELECT column_name, source_column, cleaner FROM clean_columns
  WHERE sheet_id = ? ORDER BY column_name`).all(sid)
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
    [{ websiteColumn: 'W', roles: ['SDR'], perCompany: 101 }, 'perCompany'],
    [{ websiteColumn: 'W', roles: ['SDR', '•', '***'] }, '"•" has no word']] as const) {
    const out = parseOpenRoles(v)
    assert.ok(typeof out === 'string' && out.includes(word), `${JSON.stringify(v)}: ${out}`)
  }
  const snake = parseOpenRoles({ roles: ['SDR'], perCompany: 0 }, 'snake')
  assert.ok(typeof snake === 'string' && snake.includes('website_column'), String(snake))
})

await ok('Cubex\'s own copies: a website as its domain, the day a row is found; an edit in the app sends them back, '
  + 'and a day needs no column', () => {
  const copy = [{ id: 'c1', from: 'Website', to: 'Domain', clean: 'domain' as const },
    { id: 'c2', from: '', to: 'First seen', day: 'America/Toronto' }]
  const list = { copy } as unknown as Parameters<typeof copyValues>[0]
  assert.deepEqual(copyValues(list, { Website: 'https://www.Northwind-Labs.io/about?x=1' }),
    { c1: 'northwind-labs.io', c2: today() })
  assert.deepEqual(copyValues(list, { Website: '⏳ Processing...' }), { c1: '', c2: today() })
  const base = { dest: { newSheetName: 'Roles' }, provider: null, maxItems: 5, fields: [{ path: '$.link',
    columnName: 'Link' }], dedupePath: '$.link' }
  const back = parseListInput({ ...base, copy: [{ from: 'Website', to: 'Domain', clean: 'domain' },
    { from: '', to: 'First seen', day: 'America/Toronto' }, { from: '', to: 'Day (UTC)', day: null }] })
  assert.ok(typeof back === 'object' && back !== null, String(back))
  assert.deepEqual(back.copy, [{ from: 'Website', to: 'Domain', clean: 'domain' },
    { from: '', to: 'First seen', day: 'America/Toronto' }, { from: '', to: 'Day (UTC)', day: null }])
  for (const c of [{ from: '', to: 'D', day: 'Mars/Base' }, { from: 'Website', to: 'W', clean: 'phone' }]) {
    assert.equal(typeof parseListInput({ ...base, copy: [c] }), 'string', JSON.stringify(c))
  }
})

const o = parsed({ websiteColumn: 'Website', roles: ['SDR', 'Account Executive'], country: 'US', place: 'Austin',
  postedWithinDays: 14, perCompany: 4 })

await ok('the run: the row\'s website as the one company, the roles as titles, the roles kept with the company\'s '
  + 'website as its domain and the day each is found', () => {
  const input = openRolesInput(o, 'dest-id', 'America/Toronto', false)
  assert.equal(input.toolId, 'hirebase.jobs.search')
  assert.equal(input.cleanDomains, true)
  assert.equal(input.runIf, '{{Website}} is not empty')
  assert.deepEqual(input.inputs, {
    company_domains: { value: '["{{Website}}"]' }, job_titles: { value: '["SDR","Account Executive"]' },
    geo_locations: { value: '[{"country":"United States","city":"Austin"}]' }, days_ago: { value: '14' },
  })
  const l = input.list!
  assert.deepEqual([l.maxItems, l.keep, l.itemsPath, l.provider], [4, true, '$.jobs', null])
  assert.deepEqual(l.copy, [{ from: 'Website', to: R.domain, clean: 'domain' },
    { from: '', to: R.firstSeen, day: 'America/Toronto' }])
  assert.ok(!l.fields!.some(f => f.columnName === R.domain), 'Domain is the copied cell, not the index\'s')
  assert.deepEqual(l.fields!.map(f => f.columnName), [R.title, R.company, R.team, R.location, R.posted, R.link])
  assert.equal(l.dedupePath, '$.application_link')
  const bare = openRolesInput({ ...o, country: null, place: null, postedWithinDays: null }, 'd', null, true)
  assert.deepEqual(Object.keys(bare.inputs), ['company_domains', 'job_titles'], 'a filter only when asked')
  assert.equal(bare.continueColumn, true)
  assert.deepEqual(OPEN_ROLE_COLUMNS, [R.title, R.company, R.domain, R.team, R.location, R.posted, R.link,
    R.firstSeen])
})

await ok('under the run\'s domain cleaning a website cell becomes its domain; one that cleans to nothing isn\'t '
  + 'searched; without cleaning, as before', async () => {
  const input = openRolesInput(o, '', null, false)
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
  // A column bound to the input as it is (an enrichment set up in the drawer or by an agent): its cell as before,
  // cleaning or not, and an empty one left out rather than missing.
  const bound = { ...templates, company_domains: '{{Website}}' }
  const plain = (website: string) => buildRequest(tool, bound, { Name: 'N', Website: website },
    { cleanDomains: true, columns: ['Name', 'Website'] })
  const kept = plain('https://www.Northwind-Labs.io/')
  assert.ok(kept.ok, JSON.stringify(kept))
  assert.deepEqual(JSON.parse(kept.body!).company_domains, ['https://www.Northwind-Labs.io/'])
  const left = plain('')
  assert.ok(left.ok && JSON.parse(left.body!).company_domains === undefined, JSON.stringify(left))
})

await ok('a setup saved on v0.8.48 (recalled, or a run resumed) copies as now: Domain cleaned, First seen the day; a '
  + 'hiring check\'s copies and other list jobs\' as they were', () => {
  const old = [{ id: 'c1', from: 'Website', to: R.domain },
    { id: 'c2', from: '', to: R.firstSeen, value: '2026-11-20' }]
  assert.deepEqual(openRolesCopies(HIRING_DIRECT_TOOL_ID, true, old),
    [{ id: 'c1', from: 'Website', to: R.domain, clean: 'domain' }, { id: 'c2', from: '', to: R.firstSeen, day: null }])
  type List = Parameters<typeof copyValues>[0]
  const upgraded = { copy: openRolesCopies(HIRING_DIRECT_TOOL_ID, true, old) } as unknown as List
  const values = copyValues(upgraded, { Website: 'https://www.Acme.com/jobs' })
  assert.equal(values.c1, 'acme.com')
  assert.match(values.c2, /^\d{4}-\d{2}-\d{2}$/, 'the day the role is added')
  const check = [{ id: 'c1', from: 'Role', to: R.search }, { id: 'c2', from: '', to: R.firstSeen, value: 'Nov 20' }]
  assert.deepEqual(openRolesCopies(HIRING_DIRECT_TOOL_ID, true, check), check, 'a hiring check copies none into Domain')
  assert.deepEqual(openRolesCopies(HIRING_DIRECT_TOOL_ID, false, old), old, 'roles not kept')
  assert.deepEqual(openRolesCopies('other.tool', true, old), old, 'another tool')
})

done()
