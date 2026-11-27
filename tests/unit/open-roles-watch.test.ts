// Over 200 lines: one sheet's count followed through every way a run of its column starts and ends, in order.
// Open roles' count is looked up again after any run of its column that added roles (services/open-roles-watch.ts),
// not only one started from the dialog: a rerun from the column's own menu (services/enrich-rerun.ts, which never
// goes through services/open-roles.ts) and an auto-run run (services/autorun-start.ts) are watched through the run
// start's listeners (lib/run-start-listeners.ts), a menu rerun keeping its First seen a day copy (the day each role is
// found, not the first run's); a run that added none isn't looked up whole again; and at boot a run left going is
// watched again (resumeOpenRolesWatches). A sheet searched on v0.8.48 (no domain column, the count on the website as
// written, each role's Domain the website as written then) gets its domain column and its roles' Domain cleaned at its
// next start before the count moves to the domain column, so they keep counting; one a restart or a busy sheet left
// half done is finished at boot (finishOpenRolesConversions). A column already named like the domain column's token
// form doesn't stop it. The job queue only records, so a run's end is written here; the count's last look is marked
// old first, so a new one shows.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('open-roles-watch')
const { db, uid, ok, done } = kit
const { parseOpenRoles } = await import('../../server/src/lib/hiring/open-roles-input')
const { openRoles } = await import('../../server/src/services/open-roles')
const { rerunEnrichmentColumn } = await import('../../server/src/services/enrich-rerun')
const { finishOpenRolesConversions, openRolesWatching, resumeOpenRolesWatches } =
  await import('../../server/src/services/open-roles-watch')
const { deleteSheetColumn } = await import('../../server/src/services/column-delete')
const { saveAutorunSettings } = await import('../../server/src/services/autorun-settings')
const { autorunTick } = await import('../../server/src/services/autorun-loop')
const { markAutorunInputs } = await import('../../server/src/lib/autorun-mark')
const { startDerivedFollow } = await import('../../server/src/services/derived-follow')
// As at boot: a write that queues rows for a derived column (the domain column, the count) kicks it.
startDerivedFollow()
const { OPEN_ROLES, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')

const OLD = '2000-01-01 00:00:00'
const o = parseOpenRoles({ websiteColumn: 'Website', roles: ['SDR'] })
assert.ok(typeof o === 'object', String(o))
const sid = kit.sheet([{ Website: 'northwind-labs.io' }, { Website: 'bluefin-data.io' }], ['Website'])
const count = () => db.prepare(`SELECT updated_at FROM lookup_columns WHERE sheet_id = ? AND returns = 'count'`)
  .pluck().get(sid) as string | undefined
const markOld = () => db.prepare(`UPDATE lookup_columns SET updated_at = ? WHERE sheet_id = ? AND returns = 'count'`)
  .run(OLD, sid)
// A run over, having added `added` roles (a run that added none changes no count).
const over = (runId: string, added = 1) => db.prepare(`UPDATE http_runs SET status = 'completed',
  placeholder_work = NULL, list_rows_added = ? WHERE id = ?`).run(added, runId)
async function until(what: string, test: () => boolean, ms = 30_000) {
  for (const end = Date.now() + ms; !test(); await new Promise(r => setTimeout(r, 100))) {
    assert.ok(Date.now() < end, `no ${what}`)
    await kit.idle(sid)
  }
}
// The count's fill ends after its look starts, writing updated_at again and holding the sheet meanwhile: each step
// waits for it to end before marking the look old or starting a run.
const fill = () => db.prepare(`SELECT fill_status FROM lookup_columns WHERE sheet_id = ? AND returns = 'count'`)
  .pluck().get(sid) as string | undefined
async function settled() {
  await until('the count\'s fill to end', () => fill() === 'done')
  await kit.idle(sid)
}
async function lookedAgain() {
  await until('look at the count again', () => count() !== undefined && count() !== OLD)
  await settled()
}
const ALL = { mode: 'all' as const, status: 'any' as const, test: null, rowIndexes: null }

let high = 0
let first = ''
let rolesSheet = ''
await ok('the dialog\'s run: once it is over, the count is looked up again', async () => {
  const est = await openRoles(uid, sid, { ...o, estimateOnly: true, maxCostUsd: null, timeZone: null })
  assert.ok('ok' in est && 'estimate' in est.ok, JSON.stringify(est))
  high = est.ok.estimate.highUsd
  const s = await openRoles(uid, sid, { ...o, estimateOnly: false, maxCostUsd: high, timeZone: 'America/Toronto' })
  assert.ok('ok' in s && 'started' in s.ok, JSON.stringify(s))
  first = s.ok.started.runId
  rolesSheet = s.ok.started.rolesSheetId
  await until('count', () => count() !== undefined)
  await settled()
  markOld()
  over(first)
  await lookedAgain()
})

let rerun = ''
await ok('a rerun from the column\'s menu: watched though Open roles didn\'t start it, its roles stamped with the day '
  + 'each is found', async () => {
  markOld()
  const r = await rerunEnrichmentColumn(uid, sid, { column: OPEN_ROLES.status, rows: ALL, estimateOnly: false,
    spendLimitUsd: high, rowGeneration: null, callAgain: true })
  assert.ok('ok' in r && 'runId' in r.ok, JSON.stringify(r))
  rerun = r.ok.runId
  const config = JSON.parse(db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(rerun) as string)
  assert.deepEqual(config.enrichment.list.copy.find((c: { to: string }) => c.to === R.firstSeen),
    { id: 'c2', from: '', to: R.firstSeen, day: 'America/Toronto' })
  await kit.idle(sid)
  assert.equal(count(), OLD, 'not before the run is over')
  over(rerun)
  await lookedAgain()
})

await ok('at boot, a run left going is watched again', async () => {
  // A copy of the rerun's row as a run a restart left running: nothing watches it until the resume.
  const left = uuid()
  db.exec('CREATE TEMP TABLE left_run AS SELECT * FROM http_runs WHERE 0')
  db.prepare('INSERT INTO left_run SELECT * FROM http_runs WHERE id = ?').run(rerun)
  db.prepare(`UPDATE left_run SET id = ?, status = 'running'`).run(left)
  db.exec('INSERT INTO http_runs SELECT * FROM left_run; DROP TABLE left_run')
  markOld()
  resumeOpenRolesWatches()
  assert.ok(openRolesWatching(left), 'watched again')
  await kit.idle(sid)
  assert.equal(count(), OLD, 'not before the run is over')
  over(left)
  await lookedAgain()
})

await ok('a run that added no roles: its end changes no count, so the count isn\'t looked up whole again', async () => {
  markOld()
  const r = await rerunEnrichmentColumn(uid, sid, { column: OPEN_ROLES.status, rows: ALL, estimateOnly: false,
    spendLimitUsd: high, rowGeneration: null, callAgain: true })
  assert.ok('ok' in r && 'runId' in r.ok, JSON.stringify(r))
  await kit.idle(sid)
  over(r.ok.runId, 0)
  await until('its end looked at', () => !openRolesWatching(r.ok.runId))
  assert.equal(count(), OLD, 'looked up whole for a run that added nothing')
})

await ok('an auto-run run: watched as it starts (services/autorun-start.ts), its end looks the count up again',
  async () => {
  const on = await saveAutorunSettings(uid, sid, { column: OPEN_ROLES.status, enabled: true, where: null,
    dailyCapUsd: 1, dailyRowCap: null }, { hasSecretsScope: false })
  assert.ok('ok' in on, JSON.stringify(on))
  const entry = db.prepare('SELECT id FROM autorun_columns WHERE sheet_id = ? AND status_column = ?').pluck()
    .get(sid, OPEN_ROLES.status) as string
  const added = db.prepare(`INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)`)
  added.run(uuid(), sid, uid, 2, JSON.stringify({ Website: 'copperleaf-systems.io' }))
  markAutorunInputs(sid, uid, ['Website'], { indexes: [2] })
  await kit.idle(sid)
  markOld()
  await autorunTick(entry)
  const auto = db.prepare('SELECT id FROM http_runs WHERE sheet_id = ? AND autorun_id = ? ORDER BY created_at DESC')
    .pluck().get(sid, entry) as string | undefined
  assert.ok(auto, 'an auto-run run started')
  assert.ok(openRolesWatching(auto), 'its end is watched')
  await kit.idle(sid)
  assert.equal(count(), OLD, 'not before the run is over')
  over(auto)
  await lookedAgain()
  const off = await saveAutorunSettings(uid, sid, { column: OPEN_ROLES.status, enabled: false, where: null,
    dailyCapUsd: null, dailyRowCap: null }, { hasSecretsScope: false })
  assert.ok('ok' in off, JSON.stringify(off))
})

await ok('a sheet searched on v0.8.48: its domain column made and its roles\' Domain cleaned before the count moves '
  + 'to it, so they keep counting', async () => {
  // As v0.8.48 left it: no domain column, the count on the website column, each role's Domain the website cell as
  // written then.
  db.prepare(`UPDATE lookup_columns SET source_column = 'Website' WHERE sheet_id = ? AND returns = 'count'`).run(sid)
  assert.ok('ok' in await deleteSheetColumn(sid, uid, 'Website (domain)'))
  await kit.idle(sid)
  const add = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
  const raw = ['https://www.Northwind-Labs.io/', 'bluefin-data.io/careers', 'bluefin-data.io']
  raw.forEach((domain, i) => add.run(uuid(), rolesSheet, uid, 1000 + i, JSON.stringify({ [R.title]: 'SDR',
    [R.domain]: domain, [R.link]: `https://jobs.example/old-${i}` })))
  db.prepare(`UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE sheet_id = ?`).run(sid)
  // Priced again: auto-run's company above made the sheet bigger.
  const est = await openRoles(uid, sid, { ...o, estimateOnly: true, maxCostUsd: null, timeZone: null })
  assert.ok('ok' in est && 'estimate' in est.ok, JSON.stringify(est))
  const s = await openRoles(uid, sid, { ...o, estimateOnly: false, maxCostUsd: est.ok.estimate.highUsd,
    timeZone: null })
  assert.ok('ok' in s && 'started' in s.ok, JSON.stringify(s))
  const source = () => db.prepare(`SELECT source_column FROM lookup_columns WHERE sheet_id = ? AND returns = 'count'`)
    .pluck().get(sid)
  await until('the count on the domain column', () => source() === 'Website (domain)')
  await settled()
  assert.deepEqual(kit.cells(rolesSheet, R.domain).slice(-3), ['northwind-labs.io', 'bluefin-data.io',
    'bluefin-data.io'])
  assert.deepEqual(kit.cells(sid, OPEN_ROLES.count).slice(0, 2), ['1', '2'])
})

await ok('a v0.8.48 setup run again (the column\'s menu, auto-run): it copies as now, Domain cleaned and First '
  + 'seen the day each role is found', async () => {
  db.prepare(`UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE sheet_id = ?`).run(sid)
  // The newest run as v0.8.48 saved it: the website copied as written, a fixed First seen.
  const newest = db.prepare(`SELECT id, config FROM http_runs WHERE sheet_id = ? AND setup_only = 0
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sid) as { id: string; config: string }
  const c = JSON.parse(newest.config)
  c.enrichment.list.copy = [{ id: 'c1', from: 'Website', to: R.domain },
    { id: 'c2', from: '', to: R.firstSeen, value: '2026-11-20' }]
  db.prepare('UPDATE http_runs SET config = ? WHERE id = ?').run(JSON.stringify(c), newest.id)
  const r = await rerunEnrichmentColumn(uid, sid, { column: OPEN_ROLES.status, rows: ALL, estimateOnly: false,
    spendLimitUsd: 5, rowGeneration: null, callAgain: true })
  assert.ok('ok' in r && 'runId' in r.ok, JSON.stringify(r))
  const config = JSON.parse(db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(r.ok.runId) as string)
  assert.deepEqual(config.enrichment.list.copy.map(({ id: _id, ...x }: { id: string }) => x),
    [{ from: 'Website', to: R.domain, clean: 'domain' }, { from: '', to: R.firstSeen, day: null }])
  await kit.idle(sid)
  over(r.ok.runId, 0)
  await until('its end looked at', () => !openRolesWatching(r.ok.runId))
})

await ok('at boot, a conversion a restart or a busy sheet left half done is finished: the count moves to the '
  + 'domain column, the roles\' Domain cleaned first', async () => {
  // Half done: the domain column there, roles written since with the website as written, the count not moved yet.
  db.prepare(`UPDATE lookup_columns SET source_column = 'Website' WHERE sheet_id = ? AND returns = 'count'`).run(sid)
  const add = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
  add.run(uuid(), rolesSheet, uid, 2000, JSON.stringify({ [R.title]: 'AE', [R.domain]: 'https://Bluefin-Data.io/jobs',
    [R.link]: 'https://jobs.example/later-0' }))
  finishOpenRolesConversions()
  const source = () => db.prepare(`SELECT source_column FROM lookup_columns WHERE sheet_id = ? AND returns = 'count'`)
    .pluck().get(sid)
  await until('the count on the domain column', () => source() === 'Website (domain)')
  await settled()
  assert.equal(kit.cells(rolesSheet, R.domain).at(-1), 'bluefin-data.io')
  assert.deepEqual(kit.cells(sid, OPEN_ROLES.count).slice(0, 2), ['1', '3'])
})

await ok('a column named like the domain column\'s token form ("website_domain") doesn\'t stop it: the next free name',
  async () => {
  const other = kit.sheet([{ Website: 'northwind-labs.io', website_domain: 'mine' }], ['Website', 'website_domain'])
  const est = await openRoles(uid, other, { ...o, estimateOnly: true, maxCostUsd: null, timeZone: null })
  assert.ok('ok' in est && 'estimate' in est.ok, JSON.stringify(est))
  const s = await openRoles(uid, other, { ...o, estimateOnly: false, maxCostUsd: est.ok.estimate.highUsd,
    timeZone: null })
  assert.ok('ok' in s && 'started' in s.ok, JSON.stringify(s))
  const domain = () => db.prepare(`SELECT column_name FROM clean_columns WHERE sheet_id = ? AND cleaner = 'domain'`)
    .pluck().get(other) as string | undefined
  for (const end = Date.now() + 30_000; !domain(); await new Promise(r => setTimeout(r, 100))) {
    assert.ok(Date.now() < end, 'no domain column')
    await kit.idle(other)
  }
  assert.equal(domain(), 'Website (domain) 2')
  assert.equal(kit.cells(other, 'website_domain')[0], 'mine', 'the person\'s column left alone')
})

await ok('a count the person deleted stays deleted: a run\'s end doesn\'t add it back', async () => {
  db.prepare(`UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE sheet_id = ?`).run(sid)
  assert.ok('ok' in await deleteSheetColumn(sid, uid, OPEN_ROLES.count))
  await kit.idle(sid)
  const r = await rerunEnrichmentColumn(uid, sid, { column: OPEN_ROLES.status, rows: ALL, estimateOnly: false,
    spendLimitUsd: 5, rowGeneration: null, callAgain: true })
  assert.ok('ok' in r && 'runId' in r.ok, JSON.stringify(r))
  await kit.idle(sid)
  over(r.ok.runId)
  await until('its end looked at', () => !openRolesWatching(r.ok.runId))
  assert.equal(count(), undefined, 'the count added back')
  assert.ok(!(JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(sid) as string) as
    string[]).includes(OPEN_ROLES.count))
})

done()
