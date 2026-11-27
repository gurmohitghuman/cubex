// Over 200 lines: one feature's cases in order, each building on the sheet the one before left.
// Open roles at the companies on a person's own sheet (lib/hiring/open-roles-input.ts, services/open-roles.ts,
// lib/enrich-request.ts) against the repo's mock treg, the job queue only recording (no search runs); the ask and the
// request each company row makes are in open-roles-input.test.ts:
// - the estimate is free (only the free count is called, over the companies with a website) and makes nothing;
// - a start over the estimate's most is refused with the new estimate, nothing made; an agent's refusal makes
//   nothing either;
// - the start makes the Open roles sheet beside the sheet, the search column and the lookup, and runs with the
//   estimate's most as its spend limit; a second start reuses all three, with the new day as First seen; a run still
//   going is refused;
// - names the person already uses are left alone (a number after ours); a hiring table's sheets are refused.
import assert from 'node:assert/strict'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('open-roles')
const { db, uid, ok, done, sheet } = kit
const { parseOpenRoles, OPEN_ROLE_COLUMNS } =
  await import('../../server/src/lib/hiring/open-roles-input')
const { openRoles, openRolesSetup } = await import('../../server/src/services/open-roles')
const { inputTemplates } = await import('../../server/src/lib/enrich-run-config')
const { recallChoices } = await import('../../server/src/lib/enrich-run-recall')
const { clearTregToken, saveTregToken } = await import('../../server/src/services/treg-key')
const { renameSheetColumn } = await import('../../server/src/services/column-rename')
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
const columnsOf = (sid: string) => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
  .get(sid) as string) as string[]
const lookups = (sid: string) => db.prepare(`SELECT column_name, returns, match_column, source_column
  FROM lookup_columns WHERE sheet_id = ? ORDER BY column_name`).all(sid)
const cleans = (sid: string) => db.prepare(`SELECT column_name, source_column, cleaner FROM clean_columns
  WHERE sheet_id = ? ORDER BY column_name`).all(sid)
// The count is made after the start without keeping it waiting: once the start has set up the rows, in the
// background (services/open-roles-lookups.ts). Polled until it is there.
async function countOn(sid: string, column: string, source: string): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    await kit.idle(sid)
    const made = lookups(sid) as Array<{ column_name: string; source_column: string }>
    if (made.some(l => l.column_name === column && l.source_column === source)) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`no "${column}" lookup on ${source}: ${JSON.stringify(lookups(sid))}`)
}
const newestConfig = (sid: string) => JSON.parse(db.prepare(`SELECT config FROM http_runs WHERE sheet_id = ?
  AND setup_only = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1`).pluck().get(sid) as string)
const parsed = (v: Record<string, unknown>) => {
  const p = parseOpenRoles(v)
  assert.ok(typeof p === 'object', String(p))
  return p
}

const o = parsed({ websiteColumn: 'Website', roles: ['SDR', 'Account Executive'], country: 'US', place: 'Austin',
  postedWithinDays: 14, perCompany: 4 })


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
  assert.deepEqual([est.matches?.counted, est.matches?.asked], [3, 3], JSON.stringify(est.matches))
  assert.ok((est.matches?.about ?? 0) > 0, JSON.stringify(est.matches))
  // One company's count failing leaves the others' (on real treg one did, and the estimate had no count at all).
  await fetch(`${TREG}/__mock/state`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobCountFailDomains: ['bluefin-data.io'] }) })
  try {
    const partial = await ask()
    assert.ok('ok' in partial && 'estimate' in partial.ok, JSON.stringify(partial))
    const m = partial.ok.estimate.matches
    assert.deepEqual([m?.counted, m?.asked, m?.about], [2, 3, est.matches!.about * 2 / 3], JSON.stringify(m))
  } finally {
    await fetch(`${TREG}/__mock/state`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobCountFailDomains: [] }) })
  }
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
await ok('the start: the Open roles sheet beside, the search column, the lookup, and the run with the estimate\'s '
  + 'most as its spend limit and the day as First seen', async () => {
  const s = await ask({ estimateOnly: false, maxCostUsd: high })
  assert.ok('ok' in s && 'started' in s.ok, JSON.stringify(s))
  const st = s.ok.started
  rolesSheet = st.rolesSheetId
  assert.deepEqual([st.column, st.rolesSheetName], [OPEN_ROLES.status, OPEN_ROLES.sheet])
  // Answered at once: the rows' setup holds the sheet, so the count comes after (or is there if it was quick).
  assert.ok(st.lookupsLeft !== null || st.lookups[0] === OPEN_ROLES.count, JSON.stringify(st))
  await countOn(sid, OPEN_ROLES.count, 'Website (domain)')
  assert.deepEqual(rolesSheets(), ['Open roles'])
  assert.deepEqual(columnsOf(rolesSheet), OPEN_ROLE_COLUMNS)
  assert.deepEqual(columnsOf(sid), ['Name', 'Website', OPEN_ROLES.status, 'Website (domain)', OPEN_ROLES.count])
  assert.deepEqual(cleans(sid), [{ column_name: 'Website (domain)', source_column: 'Website', cleaner: 'domain' }])
  assert.deepEqual(lookups(sid), [
    { column_name: OPEN_ROLES.count, returns: 'count', match_column: R.domain, source_column: 'Website (domain)' },
  ])
  const c = newestConfig(sid)
  assert.equal(runsOn(sid), 1)
  assert.equal(c.enrichment.toolId, 'hirebase.jobs.search')
  assert.equal(c.enrichment.list.destSheetId, rolesSheet)
  assert.equal(c.enrichment.list.keep, true)
  assert.deepEqual(c.enrichment.list.copy.filter((x: { to: string }) => x.to === R.firstSeen)
    .map((x: { day: string }) => x.day), ['America/Toronto'])
  // A rerun from the column's menu takes them as they are (enrich-run-recall.ts).
  assert.deepEqual(recallChoices(c, OPEN_ROLES.status).list!.copy, [{ from: 'Website', to: R.domain, clean: 'domain' },
    { from: '', to: R.firstSeen, day: 'America/Toronto' }])
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
  assert.equal(lookups(sid).length, 1)
  const c = newestConfig(sid)
  assert.deepEqual(c.enrichment.list.copy.filter((x: { to: string }) => x.to === R.firstSeen)
    .map((x: { day: string }) => x.day), ['America/Toronto'])
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

await ok('with no treg key a start is refused before anything is made; a renamed search column is still the one '
  + 'run again; another website column moves the count to it', async () => {
  await kit.idle(sid)
  db.prepare(`UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE sheet_id = ?`).run(sid)
  const fresh = sheet([{ Website: 'northwind-labs.io' }], ['Website'])
  clearTregToken(uid)
  try {
    const e = await openRoles(uid, fresh, { ...o, estimateOnly: true, maxCostUsd: null, timeZone: null })
    assert.ok('ok' in e && 'estimate' in e.ok, JSON.stringify(e))
    const s = await openRoles(uid, fresh, { ...o, estimateOnly: false, maxCostUsd: e.ok.estimate.highUsd,
      timeZone: null })
    assert.deepEqual(s, { fail: 'conflict', message: 'Add your treg key in Settings first.' })
    assert.deepEqual(rolesSheets(), ['Open roles'], 'no sheet made')
    assert.deepEqual(columnsOf(fresh), ['Website'])
  } finally { saveTregToken(uid, 'treg_mock_unit_team_key') }
  const renamed = await renameSheetColumn(sid, uid, OPEN_ROLES.status, 'Hiring?')
  assert.ok('ok' in renamed || 'success' in renamed || !('fail' in renamed), JSON.stringify(renamed))
  await kit.idle(sid)
  db.prepare(`UPDATE sheets SET column_order = json_insert(column_order, '$[#]', 'Site') WHERE id = ?`).run(sid)
  COMPANIES.forEach((c, i) => kit.edit(sid, i, 'Site', c.Website))
  const again = await ask({ estimateOnly: false, maxCostUsd: high, websiteColumn: 'Site' })
  assert.ok('ok' in again && 'started' in again.ok, JSON.stringify(again))
  assert.deepEqual([again.ok.started.column, again.ok.started.rolesSheetId], ['Hiring?', rolesSheet])
  assert.deepEqual(rolesSheets(), ['Open roles'], 'no second sheet')
  await countOn(sid, OPEN_ROLES.count, 'Site (domain)')
  assert.deepEqual(lookups(sid).map(l => [l.column_name, l.source_column]), [[OPEN_ROLES.count, 'Site (domain)']])
})

await ok('names the person already uses are left alone; a hiring table\'s sheets and a missing column are refused',
  async () => {
  const own = sheet([{ Website: 'quillmark.io', [OPEN_ROLES.status]: 'mine', [OPEN_ROLES.count]: '7' }],
    ['Website', OPEN_ROLES.status, OPEN_ROLES.count])
  const e = await openRoles(uid, own, { ...o, estimateOnly: true, maxCostUsd: null, timeZone: null })
  assert.ok('ok' in e && 'estimate' in e.ok, JSON.stringify(e))
  const s = await openRoles(uid, own, { ...o, estimateOnly: false, maxCostUsd: e.ok.estimate.highUsd, timeZone: null })
  assert.ok('ok' in s && 'started' in s.ok, JSON.stringify(s))
  assert.equal(s.ok.started.column, `${OPEN_ROLES.status} 2`)
  await countOn(own, `${OPEN_ROLES.count} 2`, 'Website (domain)')
  assert.deepEqual(rolesSheets(), ['Open roles', 'Open roles 2'], 'a free name in the table')
  const missing = await openRoles(uid, sid, { ...o, websiteColumn: 'Nowhere', estimateOnly: true, maxCostUsd: null,
    timeZone: null })
  assert.ok('fail' in missing && missing.message.includes('"Nowhere"'), JSON.stringify(missing))
  db.prepare(`INSERT INTO hiring_signals (id, user_id, table_id, companies_sheet_id, roles_sheet_id,
      searches_sheet_id, roles) VALUES ('h1', ?, (SELECT table_id FROM sheets WHERE id = ?), ?, NULL, NULL, '[]')`)
    .run(uid, own, own)
  const hiring = await openRoles(uid, own, { ...o, estimateOnly: true, maxCostUsd: null, timeZone: null })
  assert.ok('fail' in hiring && hiring.message.includes('hiring table'), JSON.stringify(hiring))
})

done()
