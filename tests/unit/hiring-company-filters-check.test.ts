// A hiring table made with filters on Companies (lib/hiring/company-filters.ts, services/hiring-create.ts,
// hiring-check.ts, hiring-check-watch.ts, hiring-agent.ts) against the repo's mock treg, the job queue only
// recording (no search runs): /api/v1 and MCP take min_roles and leave_out_companies and answer them back, a table
// without them answers as before; they keep the routed search, and its estimate and free count are the same as a
// table's without them (their roles are still searched and paid for); a check sums up only the companies they
// keep and records how many they kept off, which get answers for a table made with them.
import assert from 'node:assert/strict'
import { tregKit, sleep } from './token-replay-treg-kit'
const kit = await tregKit('hiring-company-filters-check')
const { db, uid, ok, done } = kit
const { agentCreateHiring, agentGetHiring, agentCheckHiring } = await import('../../server/src/services/hiring-agent')
const { estimateHiringCheck, startHiringCheck } = await import('../../server/src/services/hiring-check')
const { hiringFor, loadHiringCheck } = await import('../../server/src/services/hiring-store')
const { newestColumnRun } = await import('../../server/src/services/enrich-column')
const { COMPANY_COLUMNS: C, ROLE_COLUMNS: R, HIRING_TOOL_ID } = await import('../../server/src/lib/hiring/names')
const TREG = process.env.TREG_BASE_URL!

type Req = { path: string; body: string }
const requests = async () => ((await (await fetch(`${TREG}/__mock/requests`)).json()) as Req[])
  .filter(r => r.path.startsWith('/call/'))
const reset = () => fetch(`${TREG}/__mock/reset`, { method: 'POST' })
async function until(what: string, cond: () => boolean, ms = 8_000) {
  for (const end = Date.now() + ms; !cond(); await sleep(100)) if (Date.now() > end) throw new Error(`no ${what}`)
}

const made = await agentCreateHiring(uid, { roles: ['SDR'], country: 'US', min_roles: '2',
  leave_out_companies: 'https://www.Ford.com, acme.io' })
assert.ok('ok' in made, JSON.stringify(made))
const id = made.ok.id
const plain = await agentCreateHiring(uid, { roles: ['SDR'], country: 'US' })
assert.ok('ok' in plain, JSON.stringify(plain))

await ok('/api/v1 and MCP: taken and answered back; a table without them as before; exact refusals', async () => {
  assert.deepEqual([made.ok.min_roles, made.ok.leave_out_companies], [2, ['ford.com', 'acme.io']])
  const rec = hiringFor(uid, id)!
  assert.deepEqual([rec.min_roles, rec.leave_out_companies], [2, '["ford.com","acme.io"]'])
  assert.ok(!('min_roles' in plain.ok) && !('leave_out_companies' in plain.ok), Object.keys(plain.ok).join())
  assert.deepEqual(await agentCreateHiring(uid, { roles: ['SDR'], min_roles: 0 }),
    { fail: 'bad_request', message: 'min_roles must be a whole number from 1 to 100.' })
  assert.deepEqual(await agentCreateHiring(uid, { roles: ['SDR'], companies: ['ford.com'],
    leave_out_companies: ['ford.com'] }),
  { fail: 'bad_request', message: 'ford.com is in both companies and leave_out_companies: take it out of one.' })
})

await ok('the routed search, and the same estimate and free count as without them', async () => {
  for (const t of [id, plain.ok.id]) {
    const rec = hiringFor(uid, t)!
    assert.equal(newestColumnRun(rec.searches_sheet_id!, uid, 'Roles found')!.config.enrichment.toolId, HIRING_TOOL_ID)
  }
  await reset()
  const a = await estimateHiringCheck(uid, hiringFor(uid, id)!)
  const first = (await requests()).map(r => [r.path, r.body])
  await reset()
  const b = await estimateHiringCheck(uid, hiringFor(uid, plain.ok.id)!)
  assert.ok(!('fail' in a) && !('fail' in b), JSON.stringify([a, b]))
  assert.deepEqual(a.estimate, b.estimate)
  assert.ok(a.estimate.matches, 'a free count')
  assert.deepEqual(first, (await requests()).map(r => [r.path, r.body]), 'the same count asked')
})

await ok('a check sums up only the companies they keep and records how many they kept off', async () => {
  const rec = hiringFor(uid, id)!
  const est = await estimateHiringCheck(uid, rec)
  assert.ok(!('fail' in est))
  const c = await startHiringCheck(uid, rec, { timeZone: 'UTC', maxCostUsd: est.estimate.highUsd })
  assert.ok('ok' in c, JSON.stringify(c))
  // What the search's run would add to Roles (the queue only records here).
  let index = 0
  for (const [company, domain, n] of [['Acme', 'acme.io', 3], ['Bluefin', 'bluefin.io', 2], ['Ford', 'ford.com', 4],
    ['Quill', 'quill.io', 1]] as const) {
    for (let i = 0; i < n; i++) {
      const rowId = crypto.randomUUID()
      db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(rowId,
        rec.roles_sheet_id, uid, index++, JSON.stringify({ [R.title]: `SDR ${i}`, [R.company]: company,
          [R.domain]: domain, [R.link]: `https://jobs.${domain}/${i}` }))
      db.prepare(`INSERT INTO enrichment_list_rows (dest_row_id,user_id,dest_sheet_id,source_sheet_id,source_row_id,
        status_column,run_id,dedupe_key) VALUES (?,?,?,?,?,?,?,?)`)
        .run(rowId, uid, rec.roles_sheet_id, null, 'src', 'Roles found', c.ok.runId, `k-${index}`)
    }
  }
  db.prepare("UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE id = ?").run(c.ok.runId)
  await until('done', () => loadHiringCheck(uid, c.ok.id)!.stage === 'done')
  const done = loadHiringCheck(uid, c.ok.id)!
  assert.deepEqual([done.companies_new, done.companies_kept_off], [1, 3], 'Bluefin; Acme and Ford left out, Quill 1')
  const companies = (db.prepare('SELECT data FROM rows WHERE sheet_id = ?').pluck().all(rec.companies_sheet_id) as
    string[]).map(d => JSON.parse(d)[C.domain])
  assert.deepEqual(companies, ['bluefin.io'])
  const got = agentGetHiring(uid, id)
  assert.ok('ok' in got)
  assert.equal(got.ok.checks[0].companies_kept_off, 3)
  const none = agentGetHiring(uid, plain.ok.id)
  assert.ok('ok' in none && !('min_roles' in none.ok))
})

await ok('a check started over /api/v1 or MCP answers its kept off count only for a table made with them', async () => {
  for (const [t, has] of [[id, true], [plain.ok.id, false]] as const) {
    const est = await estimateHiringCheck(uid, hiringFor(uid, t)!)
    assert.ok(!('fail' in est))
    const out = await agentCheckHiring(uid, 'filters-token', t, { estimateOnly: false,
      maxCostUsd: est.estimate.highUsd })
    assert.ok('ok' in out, JSON.stringify(out))
    assert.equal('companies_kept_off' in out.ok, has, Object.keys(out.ok).join())
    db.prepare("UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE id = ?").run(out.ok.run_id)
    await until('done', () => loadHiringCheck(uid, out.ok.id as string)!.stage === 'done')
  }
})

kit.stop()
done()
