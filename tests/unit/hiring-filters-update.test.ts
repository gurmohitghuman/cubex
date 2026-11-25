// A hiring table's filters on Companies changed after create (services/hiring-filters-set.ts, hiring-agent.ts), on
// the repo's mock treg with the job queue only recording (no search runs): either or both change, the other kept;
// null resets one; the answer always names both; the change is on Companies' History; the refusals (nothing sent,
// anything else sent, a bad value, a company also in "only these companies", a check going, no such table); the
// app's camelCase names; and the next check sums up Companies by the new filters, so a company kept off before gets
// its row and a row already there stays.
import assert from 'node:assert/strict'
import { tregKit, sleep } from './token-replay-treg-kit'
const kit = await tregKit('hiring-filters-update')
const { db, uid, ok, done } = kit
const { agentCreateHiring, agentUpdateHiring } = await import('../../server/src/services/hiring-agent')
const { setHiringCompanyFilters } = await import('../../server/src/services/hiring-filters-set')
const { estimateHiringCheck, startHiringCheck } = await import('../../server/src/services/hiring-check')
const { hiringFor, loadHiringCheck } = await import('../../server/src/services/hiring-store')
const { COMPANY_COLUMNS: C, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')

async function until(what: string, cond: () => boolean, ms = 8_000) {
  for (const end = Date.now() + ms; !cond(); await sleep(100)) if (Date.now() > end) throw new Error(`no ${what}`)
}
const made = await agentCreateHiring(uid, { roles: ['SDR'], country: 'US', min_roles: 2,
  leave_out_companies: ['ford.com'] })
assert.ok('ok' in made, JSON.stringify(made))
const id = made.ok.id as string
const only = await agentCreateHiring(uid, { roles: ['SDR'], companies: ['ramp.com', 'acme.io'] })
assert.ok('ok' in only, JSON.stringify(only))
const filtersOf = (t: string) => {
  const r = hiringFor(uid, t)!
  return [r.min_roles, JSON.parse(r.leave_out_companies)]
}

await ok('either or both change, the other kept; null resets; the answer names both; History says so', () => {
  const a = agentUpdateHiring(uid, id, { min_roles: '3' })
  assert.ok('ok' in a, JSON.stringify(a))
  assert.deepEqual([a.ok.min_roles, a.ok.leave_out_companies], [3, ['ford.com']])
  assert.deepEqual(filtersOf(id), [3, ['ford.com']])
  const b = agentUpdateHiring(uid, id, { leave_out_companies: 'https://www.Quill.io, ford.com' })
  assert.ok('ok' in b, JSON.stringify(b))
  assert.deepEqual(filtersOf(id), [3, ['quill.io', 'ford.com']])
  const c = agentUpdateHiring(uid, id, { min_roles: null, leave_out_companies: null })
  assert.ok('ok' in c, JSON.stringify(c))
  assert.deepEqual([c.ok.min_roles, c.ok.leave_out_companies], [1, []], 'named although none now')
  assert.deepEqual(filtersOf(id), [1, []])
  const lines = db.prepare(`SELECT summary, detail FROM sheet_changes WHERE sheet_id = ? AND action = 'hiring_filters'
    ORDER BY id`).all(hiringFor(uid, id)!.companies_sheet_id) as Array<{ summary: string; detail: string }>
  assert.deepEqual(lines.map(l => l.summary), [
    'Companies now gets a row for companies with at least 3 matching roles, leaving out ford.com, from the next check',
    'Companies now gets a row for companies with at least 3 matching roles, leaving out quill.io, ford.com, from '
      + 'the next check',
    'Companies now gets a row for every company, from the next check',
  ])
  assert.deepEqual(JSON.parse(lines[2].detail).was, { min_roles: 3, leave_out_companies: ['quill.io', 'ford.com'] })
})

await ok('the refusals', () => {
  assert.deepEqual(agentUpdateHiring(uid, id, {}),
    { fail: 'bad_request', message: 'Send min_roles, leave_out_companies or both.' })
  const other = agentUpdateHiring(uid, id, { min_roles: 2, roles: ['AE'], country: 'DE' })
  assert.ok('fail' in other && /Only min_roles and leave_out_companies change after create \(not roles, country\)/
    .test(other.message), JSON.stringify(other))
  assert.deepEqual(agentUpdateHiring(uid, id, { min_roles: 0 }),
    { fail: 'bad_request', message: 'min_roles must be a whole number from 1 to 100.' })
  assert.deepEqual(agentUpdateHiring(uid, only.ok.id, { leave_out_companies: ['careers.ramp.com'] }), { fail:
    'bad_request', message: 'careers.ramp.com in leave_out_companies is the same company as ramp.com in companies: '
      + 'take it out of one.' })
  assert.deepEqual(agentUpdateHiring(uid, 'nope', { min_roles: 2 }),
    { fail: 'not_found', message: 'Hiring table not found' })
  assert.deepEqual(filtersOf(id), [1, []], 'nothing changed by a refusal')
})

await ok("the app's names, by the table's Companies sheet id too", () => {
  const out = setHiringCompanyFilters(uid, hiringFor(uid, id)!.companies_sheet_id, { minRoles: 2 }, 'camel')
  assert.ok('ok' in out, JSON.stringify(out))
  assert.deepEqual([out.ok.minRoles, out.ok.leaveOutCompanies], [2, []])
  const bad = setHiringCompanyFilters(uid, id, { minRoles: 'lots' }, 'camel')
  assert.ok('fail' in bad && bad.message === 'minRoles must be a whole number from 1 to 100.', JSON.stringify(bad))
})

// A check whose search adds these roles to Roles (the queue only records here), done once its summary is.
async function check(roles: Array<[string, string, number]>) {
  const rec = hiringFor(uid, id)!
  const est = await estimateHiringCheck(uid, rec)
  assert.ok(!('fail' in est))
  const c = await startHiringCheck(uid, rec, { timeZone: 'UTC', maxCostUsd: est.estimate.highUsd })
  assert.ok('ok' in c, JSON.stringify(c))
  let index = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(rec.roles_sheet_id) as number
  for (const [company, domain, n] of roles) {
    for (let i = 0; i < n; i++) {
      const rowId = crypto.randomUUID()
      db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(rowId,
        rec.roles_sheet_id, uid, index++, JSON.stringify({ [R.title]: `SDR ${i}`, [R.company]: company,
          [R.domain]: domain, [R.link]: `https://jobs.${domain}/${i}` }))
      db.prepare(`INSERT INTO enrichment_list_rows (dest_row_id,user_id,dest_sheet_id,source_sheet_id,source_row_id,
        status_column,run_id,dedupe_key) VALUES (?,?,?,?,?,?,?,?)`)
        .run(rowId, uid, rec.roles_sheet_id, null, 'src', 'Roles found', c.ok.runId, `k-${domain}-${i}`)
    }
  }
  return { rec, c }
}
const companiesOn = (sheet: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().all(sheet) as string[]).map(d => JSON.parse(d)[C.domain]).sort()

await ok('refused while a check is going; the next check sums up Companies by the new filters', async () => {
  // min_roles 2 now: Bluefin (2 roles) gets a row, Quill (1) is kept off.
  const { rec, c } = await check([['Bluefin', 'bluefin.io', 2], ['Quill', 'quill.io', 1]])
  const going = agentUpdateHiring(uid, id, { min_roles: 1 })
  assert.ok('fail' in going && going.fail === 'conflict' && /A check of this table is going/.test(going.message),
    JSON.stringify(going))
  db.prepare("UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE id = ?").run(c.ok.runId)
  await until('the first check', () => loadHiringCheck(uid, c.ok.id)!.stage === 'done')
  assert.deepEqual(companiesOn(rec.companies_sheet_id), ['bluefin.io'])
  // Every company now, Bluefin left out: Quill gets its row at the next check, Bluefin's row stays.
  const changed = agentUpdateHiring(uid, id, { min_roles: 1, leave_out_companies: ['bluefin.io'] })
  assert.ok('ok' in changed, JSON.stringify(changed))
  assert.deepEqual(companiesOn(rec.companies_sheet_id), ['bluefin.io'], 'nothing changes before the next check')
  const next = await check([])
  db.prepare("UPDATE http_runs SET status = 'completed', placeholder_work = NULL WHERE id = ?").run(next.c.ok.runId)
  await until('the next check', () => loadHiringCheck(uid, next.c.ok.id)!.stage === 'done')
  assert.deepEqual(companiesOn(rec.companies_sheet_id), ['bluefin.io', 'quill.io'])
})

kit.stop()
done()
