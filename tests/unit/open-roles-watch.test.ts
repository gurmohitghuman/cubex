// Open roles' count is looked up again after any run of its column (services/open-roles-lookups.ts), not only one
// started from the dialog: a rerun from the column's own menu (services/enrich-rerun.ts, which never goes through
// services/open-roles.ts) is watched through the run start's listeners (lib/run-start-listeners.ts) and keeps its
// First seen a day copy (the day each role is found, not the first run's); and at boot a run left going is watched
// again (resumeOpenRolesWatches). Each looks the count up again once its run is over. A sheet searched on v0.8.48 (the
// count on the website as written, each role's Domain the website as written then) has its roles' Domain cleaned at
// its next start before the count moves to the domain column, so they keep counting. The job queue only records, so a
// run's end is written here; the count's last look is marked old first, so a new one shows.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('open-roles-watch')
const { db, uid, ok, done } = kit
const { parseOpenRoles } = await import('../../server/src/lib/hiring/open-roles-input')
const { openRoles } = await import('../../server/src/services/open-roles')
const { rerunEnrichmentColumn } = await import('../../server/src/services/enrich-rerun')
const { resumeOpenRolesWatches } = await import('../../server/src/services/open-roles-lookups')
const { OPEN_ROLES, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')

const OLD = '2000-01-01 00:00:00'
const o = parseOpenRoles({ websiteColumn: 'Website', roles: ['SDR'] })
assert.ok(typeof o === 'object', String(o))
const sid = kit.sheet([{ Website: 'northwind-labs.io' }, { Website: 'bluefin-data.io' }], ['Website'])
const count = () => db.prepare(`SELECT updated_at FROM lookup_columns WHERE sheet_id = ? AND returns = 'count'`)
  .pluck().get(sid) as string | undefined
const markOld = () => db.prepare(`UPDATE lookup_columns SET updated_at = ? WHERE sheet_id = ? AND returns = 'count'`)
  .run(OLD, sid)
const over = (runId: string) => db.prepare(`UPDATE http_runs SET status = 'completed', placeholder_work = NULL
  WHERE id = ?`).run(runId)
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
  await new Promise(r => setTimeout(r, 300))
  assert.equal(count(), OLD, 'not before the run is over')
  over(left)
  await lookedAgain()
})

await ok('a sheet searched on v0.8.48: its roles\' Domain cleaned before the count moves to the domain column, so '
  + 'they keep counting', async () => {
  // As v0.8.48 left it: the count on the website column, each role's Domain the website cell as written then.
  db.prepare(`UPDATE lookup_columns SET source_column = 'Website' WHERE sheet_id = ? AND returns = 'count'`).run(sid)
  const add = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
  const raw = ['https://www.Northwind-Labs.io/', 'bluefin-data.io/careers', 'bluefin-data.io']
  raw.forEach((domain, i) => add.run(uuid(), rolesSheet, uid, 1000 + i, JSON.stringify({ [R.title]: 'SDR',
    [R.domain]: domain, [R.link]: `https://jobs.example/old-${i}` })))
  db.prepare(`UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE sheet_id = ?`).run(sid)
  const s = await openRoles(uid, sid, { ...o, estimateOnly: false, maxCostUsd: high, timeZone: null })
  assert.ok('ok' in s && 'started' in s.ok, JSON.stringify(s))
  const source = () => db.prepare(`SELECT source_column FROM lookup_columns WHERE sheet_id = ? AND returns = 'count'`)
    .pluck().get(sid)
  await until('the count on the domain column', () => source() === 'Website (domain)')
  await settled()
  assert.deepEqual(kit.cells(rolesSheet, R.domain).slice(-3), ['northwind-labs.io', 'bluefin-data.io',
    'bluefin-data.io'])
  assert.deepEqual(kit.cells(sid, OPEN_ROLES.count), ['1', '2'])
})

done()
