// Find buyers on a hiring table (services/hiring-buyer.ts, lib/hiring/buyer.ts) against the repo's mock treg, the
// job queue only recording (nothing runs): the starting titles and how titles are read; the first call saves the two
// columns on Companies, not run (the people search on the company's website with the titles, one person; the verified
// email on that person), and prices both, calling nothing paid; the same titles again save nothing, new ones save the
// search's setup again and keep its cells; columns of the same names in the way are named; a run sent the estimate's
// most starts one column run, the email after the search, and one sent less is refused with the estimate.
import assert from 'node:assert/strict'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('hiring-buyer')
const { db, uid, ok, done } = kit
const { parseHiringInput } = await import('../../server/src/lib/hiring/input')
const { createHiringTable } = await import('../../server/src/services/hiring-create')
const { hiringFor } = await import('../../server/src/services/hiring-store')
const { buyerOf, findBuyers } = await import('../../server/src/services/hiring-buyer')
const { buyerTitlesFor, parseBuyerTitles, BUYER_MAX_TITLES } = await import('../../server/src/lib/hiring/buyer')
const { BUYER_COLUMNS: B, COMPANY_COLUMNS: C } = await import('../../server/src/lib/hiring/names')
const { getSheetColumns } = await import('../../server/src/lib/sql-helpers')
const TREG = process.env.TREG_BASE_URL!

const paidCalls = async () => ((await (await fetch(`${TREG}/__mock/requests`)).json()) as Array<{ path: string }>)
  .map(r => r.path).filter(p => p.startsWith('/call'))
const resetCalls = () => fetch(`${TREG}/__mock/reset`, { method: 'POST' })
async function table(roles: string[]) {
  const input = parseHiringInput({ roles, country: 'US' })
  assert.ok(typeof input === 'object')
  const made = await createHiringTable(uid, input)
  assert.ok('ok' in made, JSON.stringify(made))
  const sid = made.ok.companiesSheetId
  const ins = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
  for (const [i, [company, domain]] of [['Acme', 'acme.com'], ['Nobody Inc', 'nobody.example'], ['Beta', 'beta.io']]
    .entries()) ins.run(crypto.randomUUID(), sid, uid, i, JSON.stringify({ [C.company]: company, [C.domain]: domain }))
  return { rec: () => hiringFor(uid, made.ok.id)!, sid }
}
const setups = (sid: string, column: string) => db.prepare(`SELECT setup_only, config FROM http_runs
  WHERE sheet_id = ? AND master_column_name = ? ORDER BY created_at, rowid`).all(sid, column) as
  Array<{ setup_only: number; config: string }>

await ok('the starting titles: by the roles\' words, in order, each once, at most six; none for other roles', () => {
  assert.deepEqual(buyerTitlesFor(['SDR', 'BDRs']), ['Head of Sales Development', 'VP Sales', 'Head of Sales'])
  assert.deepEqual(buyerTitlesFor(['Senior Account Executive']), ['VP Sales', 'Head of Sales', 'Chief Revenue Officer'])
  assert.deepEqual(buyerTitlesFor(['RevOps Manager']).slice(0, 1), ['Head of Revenue Operations'])
  assert.deepEqual(buyerTitlesFor(['Chef', 'Driver']), [])
  assert.equal(buyerTitlesFor(['SDR', 'Marketing Manager', 'Data Engineer']).length, BUYER_MAX_TITLES)
})

await ok('titles as given: a list or a comma list, each once in any case; none, too many or too long refused', () => {
  assert.deepEqual(parseBuyerTitles('Head of Sales, VP Sales\n head of sales ', 'titles'),
    ['Head of Sales', 'VP Sales'])
  assert.deepEqual(parseBuyerTitles(['CRO'], 'titles'), ['CRO'])
  assert.match(parseBuyerTitles(' , ', 'titles') as string, /at least one job title/)
  assert.match(parseBuyerTitles(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'titles') as string, /at most 6/)
  assert.match(parseBuyerTitles(['x'.repeat(81)], 'titles') as string, /over 80 characters/)
  assert.match(parseBuyerTitles(3, 'titles') as string, /a list of job titles/)
})

const t = await table(['SDR'])
let high = 0
await ok('the first estimate saves both columns, not run, prices them and calls nothing paid', async () => {
  assert.deepEqual(buyerOf(uid, t.rec()), { added: false, titles: [], starting: buyerTitlesFor(['SDR']) })
  await resetCalls()
  const out = await findBuyers(uid, t.rec(), { titles: null, rows: 'empty', estimateOnly: true, maxCostUsd: null })
  assert.ok('ok' in out && 'estimate' in out.ok, JSON.stringify(out))
  assert.deepEqual(out.ok.saved, [B.search, B.emailSearch])
  assert.deepEqual(out.ok.titles, buyerTitlesFor(['SDR']))
  const e = out.ok.estimate
  assert.deepEqual(e.columns.map(c => c.column), [B.search, B.emailSearch])
  assert.equal(e.rows_in_scope, 3)
  assert.ok(e.columns.every(c => c.high_usd !== null && c.high_usd > 0), JSON.stringify(e.columns))
  high = e.high_usd
  assert.deepEqual(await paidCalls(), [])
  const cols = getSheetColumns(t.sid, uid, false)
  for (const c of Object.values(B)) assert.ok(cols.includes(c), `${c} in ${cols.join(', ')}`)
  const [search] = setups(t.sid, B.search)
  assert.equal(search.setup_only, 3)
  // One person a call: its most a company is Findymail's price for one, not a page of 20.
  assert.equal(JSON.parse(search.config).enrichment.maxCostPerRowUsd, 0.0198)
  const body = JSON.parse(JSON.parse(search.config).requestConfig.body)
  assert.deepEqual([body.website, JSON.parse(body.job_titles), body.count],
    [`{{${C.domain}}}`, buyerTitlesFor(['SDR']), '1'])
  const email = JSON.parse(setups(t.sid, B.emailSearch)[0].config)
  assert.equal(email.enrichment.preset, 'verified_email')
  assert.deepEqual(buyerOf(uid, t.rec()).titles, buyerTitlesFor(['SDR']))
})

await ok('the same titles save nothing; new ones save the search again and keep its cells', async () => {
  const again = await findBuyers(uid, t.rec(), { titles: null, rows: 'empty', estimateOnly: true, maxCostUsd: null })
  assert.ok('ok' in again && again.ok.saved.length === 0, JSON.stringify(again))
  const row = db.prepare('SELECT id, data FROM rows WHERE sheet_id = ? AND row_index = 0').get(t.sid) as
    { id: string; data: string }
  db.prepare('UPDATE rows SET data = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.data), [B.name]: 'Kept' }),
    row.id)
  const out = await findBuyers(uid, t.rec(), { titles: ['CRO'], rows: 'empty', estimateOnly: true, maxCostUsd: null })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.deepEqual([out.ok.saved, out.ok.titles], [[B.search], ['CRO']])
  assert.deepEqual(buyerOf(uid, t.rec()).titles, ['CRO'])
  assert.equal(setups(t.sid, B.search).length, 2)
  assert.equal(JSON.parse((db.prepare('SELECT data FROM rows WHERE id = ?').pluck().get(row.id) as string))[B.name],
    'Kept')
})

await ok('a run sent less than the estimate is refused with it; sent the most, one column run starts', async () => {
  const est = await findBuyers(uid, t.rec(), { titles: null, rows: 'empty', estimateOnly: true, maxCostUsd: null })
  assert.ok('ok' in est && 'estimate' in est.ok)
  high = est.ok.estimate.high_usd
  const under = await findBuyers(uid, t.rec(), { titles: null, rows: 'empty', estimateOnly: false,
    maxCostUsd: high / 2 })
  assert.ok('fail' in under && under.fail === 'over_ceiling' && under.estimate, JSON.stringify(under))
  const out = await findBuyers(uid, t.rec(), { titles: null, rows: 'empty', estimateOnly: false, maxCostUsd: high })
  assert.ok('ok' in out && 'setup_run' in out.ok, JSON.stringify(out))
  const steps = out.ok.setup_run.steps.map((s: { column: string }) => s.column)
  assert.deepEqual(steps, [B.search, B.emailSearch])
})

await ok('columns of the same names in the way are named; roles that start no titles ask for them', async () => {
  const other = await table(['Chef'])
  const none = await findBuyers(uid, other.rec(), { titles: null, rows: 'empty', estimateOnly: true, maxCostUsd: null })
  assert.ok('fail' in none && /Who buys\?/.test(none.message), JSON.stringify(none))
  db.prepare("UPDATE sheets SET column_order = json_insert(column_order, '$[#]', ?) WHERE id = ?")
    .run(B.title, other.sid)
  const out = await findBuyers(uid, other.rec(), { titles: ['Head Chef'], rows: 'empty', estimateOnly: true,
    maxCostUsd: null })
  assert.ok('fail' in out && out.message.includes(`"${B.title}"`), JSON.stringify(out))
  assert.equal(setups(other.sid, B.search).length, 0)
})

done()
