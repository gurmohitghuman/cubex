// A hiring table and its checks (services/hiring-create.ts, hiring-check.ts, hiring-check-watch.ts, job-count.ts)
// against the repo's mock treg, the job queue only recording (no search runs): making the table calls nothing
// paid and starts no run; the estimate is free (only the free counts are called) and makes no run nor check; a
// check's run keeps the roles found before, stamps First seen with its day and has the estimate's most as its
// spend limit; one check of a table at a time; the journal moves on once the run is over, and a restart only
// waits (a running search is never started again, a paused one stops the check with what to do, one that never
// started says so). The free count is asked only with a treg key and a provider that has one.
import assert from 'node:assert/strict'
import { tregKit, sleep } from './token-replay-treg-kit'
const kit = await tregKit('hiring-check')
const { db, uid, ok, done } = kit
const { parseHiringInput } = await import('../../server/src/lib/hiring/input')
const { createHiringTable } = await import('../../server/src/services/hiring-create')
const { estimateHiringCheck, hiringPlan, startHiringCheck } = await import('../../server/src/services/hiring-check')
const { resumeHiringChecks } = await import('../../server/src/services/hiring-check-watch')
const { hiringFor, insertHiringCheck, loadHiringCheck } = await import('../../server/src/services/hiring-store')
const { countJobs } = await import('../../server/src/services/job-count')
const { ROLE_COLUMNS: R, SEARCH_COLUMNS: S } = await import('../../server/src/lib/hiring/names')
const TREG = process.env.TREG_BASE_URL!

const calls = async () => ((await (await fetch(`${TREG}/__mock/requests`)).json()) as Array<{ path: string }>)
  .map(r => r.path).filter(p => p.startsWith('/call/'))
const resetCalls = () => fetch(`${TREG}/__mock/reset`, { method: 'POST' })
const runs = (sheetId: string) => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ? AND setup_only = 0')
  .pluck().get(sheetId) as number
const checks = () => db.prepare('SELECT COUNT(*) FROM hiring_checks').pluck().get() as number
async function until(what: string, cond: () => boolean, ms = 8_000) {
  for (const end = Date.now() + ms; !cond(); await sleep(100)) if (Date.now() > end) throw new Error(`no ${what}`)
}

const input = parseHiringInput({ roles: ['SDR', 'BDR'], country: 'US', postedWithinDays: 14 })
assert.ok(typeof input === 'object')
await resetCalls()
const made = await createHiringTable(uid, input)
assert.ok('ok' in made, JSON.stringify(made))
const t = made.ok
const rec = () => hiringFor(uid, t.id)!

await ok('making the table: three sheets, a search per role, nothing paid called and no run', async () => {
  assert.equal(t.tableName, 'Hiring: SDR, BDR')
  assert.equal(t.searches, 2)
  assert.equal(hiringFor(uid, t.companiesSheetId)?.id, t.id, 'found by its Companies sheet too')
  const searches = db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
    .all(t.searchesSheetId).map(d => JSON.parse(d as string))
  assert.deepEqual(searches.map(r => [r[S.role], r[S.country], r[S.days]]), [['SDR', 'US', '14'], ['BDR', 'US', '14']])
  assert.equal(runs(t.searchesSheetId), 0)
  assert.deepEqual(await calls(), [])
})

let high = 0
await ok('the estimate: free, no run, no check; the count asked only of the free count', async () => {
  await resetCalls()
  const e = await estimateHiringCheck(uid, rec(), { timeZone: 'America/Toronto' })
  assert.ok(!('fail' in e), JSON.stringify(e))
  assert.equal(e.estimate.searches, 2)
  assert.equal(e.estimate.rolesUpTo, 2 * t.perSearch)
  assert.ok(e.estimate.priceKnown && e.estimate.highUsd > 0, JSON.stringify(e.estimate))
  assert.equal(e.plan.since, null)
  high = e.estimate.highUsd
  const counted = (await calls()).every(p => p.endsWith('.jobs.search.count'))
  assert.ok(counted, (await calls()).join())
  assert.deepEqual(e.estimate.matches, { about: 240, counted: 2, capped: false }, `provider ${t.provider}`)
  assert.equal(runs(t.searchesSheetId), 0)
  assert.equal(checks(), 0)
})

let checkId = ''
const CHECK = 'a check: one run on every search, roles kept, First seen its day, its limit the estimate\'s most'
await ok(CHECK, async () => {
  const c = await startHiringCheck(uid, rec(), { timeZone: 'UTC' })
  assert.ok('ok' in c, JSON.stringify(c))
  checkId = c.ok.id
  assert.equal(c.ok.stage, 'searching')
  assert.equal(runs(t.searchesSheetId), 1)
  const config = JSON.parse(db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(c.ok.runId) as string)
  const e = config.enrichment
  assert.equal(e.spendLimitUsd, high)
  assert.equal(e.list.keep, true)
  assert.deepEqual(e.list.copy.filter((x: { to: string }) => x.to === R.firstSeen).map((x: { value: string }) =>
    x.value), [c.ok.label])
})

await ok('one check of a table at a time', async () => {
  const again = await startHiringCheck(uid, rec())
  assert.deepEqual(again, { fail: 'conflict', message: 'A check of this table is still going.' })
  assert.equal(insertHiringCheck(uid, t.id, 'x', null, 1), null, 'the index holds too')
  assert.equal(runs(t.searchesSheetId), 1)
})

await ok('once the run is over, the check sums up and is done; the next names this one\'s day', async () => {
  const runId = loadHiringCheck(uid, checkId)!.run_id
  // As a run's end does: its ⏳ cleared too.
  db.prepare("UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE id = ?").run(runId)
  await until('done', () => loadHiringCheck(uid, checkId)!.stage === 'done')
  const plan = hiringPlan(uid, rec())
  assert.ok(!('fail' in plan), JSON.stringify(plan))
  assert.equal(plan.since, loadHiringCheck(uid, checkId)!.label)
})

// A check a restart cut short, journaled at `stage` with a run in `status` (none: null).
function cutShort(stage: string, status: string | null): string {
  const id = insertHiringCheck(uid, t.id, '2026-11-19', null, 2)!
  let runId: string | null = null
  if (status) {
    runId = crypto.randomUUID()
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, pause_reason)
      SELECT ?, sheet_id, user_id, config, ?, master_column_name, ? FROM http_runs WHERE id = ?`)
      .run(runId, status, status === 'paused' ? 'out of treg credit' : null, loadHiringCheck(uid, checkId)!.run_id)
  }
  db.prepare('UPDATE hiring_checks SET stage = ?, run_id = ? WHERE id = ?').run(stage, runId, id)
  return id
}

await ok('a restart while the search runs only waits for it, then sums up', async () => {
  const id = cutShort('searching', 'running')
  const before = runs(t.searchesSheetId)
  await resetCalls()
  resumeHiringChecks()
  await sleep(2_500)
  assert.equal(loadHiringCheck(uid, id)!.stage, 'searching')
  assert.equal(runs(t.searchesSheetId), before, 'no run started')
  assert.deepEqual(await calls(), [], 'nothing called')
  db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(loadHiringCheck(uid, id)!.run_id)
  await until('done', () => loadHiringCheck(uid, id)!.stage === 'done')
})

await ok('a paused search stops the check and says what to do', async () => {
  const id = cutShort('searching', 'paused')
  resumeHiringChecks()
  await until('stopped', () => loadHiringCheck(uid, id)!.stage === 'stopped')
  const problems = JSON.parse(loadHiringCheck(uid, id)!.problems) as string[]
  assert.ok(problems.some(p => p.startsWith('The search paused (out of treg credit)')), problems.join())
})

await ok('a check cut short while summing up finishes it; one whose search never started says so', async () => {
  const summing = cutShort('summarizing', 'completed')
  resumeHiringChecks()
  await until('done', () => loadHiringCheck(uid, summing)!.stage === 'done')
  const never = cutShort('searching', null)
  resumeHiringChecks()
  await until('stopped', () => loadHiringCheck(uid, never)!.stage === 'stopped')
  assert.deepEqual(JSON.parse(loadHiringCheck(uid, never)!.problems), ["The search didn't start: check again."])
})

await ok('a plan refused: a table whose searches are all gone', async () => {
  db.prepare('DELETE FROM rows WHERE sheet_id = ?').run(t.searchesSheetId)
  assert.deepEqual(hiringPlan(uid, rec()),
    { fail: 'bad_request', message: 'Searches has no rows: add a role title to search for.' })
})

await ok('the free count: asked only with a treg key and a provider that has one', async () => {
  const terms = [{ title: 'SDR', country: 'US', days: 14 }]
  await resetCalls()
  const other = crypto.randomUUID()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(other, 'x')
  assert.equal(await countJobs(other, 'hirebase', terms), null, 'no treg key')
  assert.equal(await countJobs(uid, 'crustdata', terms), null, 'no count')
  assert.deepEqual(await calls(), [])
  for (const p of ['hirebase', 'jobspipe']) {
    const n = await countJobs(uid, p, [...terms, { title: 'BDR', country: '', days: null }])
    assert.deepEqual(n, { about: 240, counted: 2, capped: false }, p)
  }
  assert.deepEqual((await calls()).sort(), ['/call/hirebase.jobs.search.count', '/call/hirebase.jobs.search.count',
    '/call/jobspipe.jobs.search.count', '/call/jobspipe.jobs.search.count'])
})

kit.stop()
done()
