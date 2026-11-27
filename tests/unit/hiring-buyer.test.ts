// Find buyers on a hiring table (services/hiring-buyer.ts, hiring-buyer-price.ts, lib/hiring/buyer.ts) against the
// repo's mock treg, the job queue only recording (nothing runs): the starting titles and how titles are read; an
// estimate changes nothing (no column, no setup, no paid call) and prices both columns on every company; the first
// run saves both columns (the people search on the company's website with the titles, one person; the verified email
// on that person) and starts within the cost the estimate showed, and needs the write scope; a find takes the
// companies whose Buyer is empty, a company no one was found at too; new titles save the search's setup again and
// keep its cells; a renamed Buyer keeps its name; columns of the same names in the way are named.
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
const { renameSheetColumn } = await import('../../server/src/services/column-rename')
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
const bodyOf = (sid: string, column: string) => JSON.parse(JSON.parse(setups(sid, column).at(-1)!.config)
  .requestConfig.body)
const cols = (sid: string) => getSheetColumns(sid, uid, false)
const runsOn = (sid: string) => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sid)
type Rec = ReturnType<Awaited<ReturnType<typeof table>>['rec']>
const estimate = (rec: Rec, titles: string[] | null = null) =>
  findBuyers(uid, rec, { titles, estimateOnly: true, maxCostUsd: null })
// A run sent too little: it saves what it needs, then is refused over the most (so nothing runs).
const saveOnly = (rec: Rec, titles: string[] | null = null) =>
  findBuyers(uid, rec, { titles, estimateOnly: false, maxCostUsd: 0.000001 })
const setCells = (sid: string, place: number, cells: Record<string, string>) => {
  const row = db.prepare('SELECT id, data FROM rows WHERE sheet_id = ? AND row_index = ?').get(sid, place) as
    { id: string; data: string }
  db.prepare('UPDATE rows SET data = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.data), ...cells }), row.id)
}

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
await ok('an estimate changes nothing: no column, no setup, no paid call; it prices both columns per company', async () => {
  const before = cols(t.sid)
  await resetCalls()
  for (const titles of [null, ['CRO']]) {
    const out = await findBuyers(uid, t.rec(), { titles, estimateOnly: true, maxCostUsd: null, canSave: false })
    assert.ok('ok' in out && 'estimate' in out.ok, JSON.stringify(out))
    assert.deepEqual([out.ok.saved, out.ok.added], [[], []])
    const e = out.ok.estimate
    assert.deepEqual(e.columns.map(c => [c.column, c.rows]), [[B.search, 3], [B.emailSearch, 3]])
    assert.equal(e.rows_in_scope, 3)
    assert.ok(e.columns.every(c => c.high_usd !== null && c.high_usd > 0), JSON.stringify(e.columns))
  }
  assert.deepEqual(cols(t.sid), before)
  assert.equal(runsOn(t.sid), 0)
  assert.deepEqual(await paidCalls(), [])
  assert.deepEqual(buyerOf(uid, t.rec()),
    { added: false, titles: [], starting: buyerTitlesFor(['SDR']), catchAll: false })
})

await ok('the first run saves both columns, needs the write scope, and starts within its estimate', async () => {
  const est = await estimate(t.rec())
  assert.ok('ok' in est && 'estimate' in est.ok)
  const high = est.ok.estimate.high_usd
  const denied = await findBuyers(uid, t.rec(), { titles: null, estimateOnly: false, maxCostUsd: high,
    canSave: false })
  assert.ok('fail' in denied && denied.fail === 'forbidden', JSON.stringify(denied))
  assert.equal(runsOn(t.sid), 0)
  const out = await findBuyers(uid, t.rec(), { titles: null, estimateOnly: false, maxCostUsd: high })
  assert.ok('ok' in out && 'setup_run' in out.ok, JSON.stringify(out))
  assert.deepEqual(out.ok.saved, [B.search, B.emailSearch])
  assert.deepEqual(out.ok.setup_run.steps.map((s: { column: string }) => s.column), [B.search, B.emailSearch])
  for (const c of Object.values(B)) assert.ok(cols(t.sid).includes(c), `${c} in ${cols(t.sid).join(', ')}`)
  const [search] = setups(t.sid, B.search)
  assert.equal(search.setup_only, 3)
  // One person a call: its most a company is Findymail's price for one, not a page of 20.
  assert.equal(JSON.parse(search.config).enrichment.maxCostPerRowUsd, 0.0198)
  const body = bodyOf(t.sid, B.search)
  assert.deepEqual([body.website, JSON.parse(body.job_titles), body.count],
    [`{{${C.domain}}}`, buyerTitlesFor(['SDR']), '1'])
  assert.equal(JSON.parse(setups(t.sid, B.emailSearch)[0].config).enrichment.preset, 'verified_email')
  assert.deepEqual(buyerOf(uid, t.rec()).titles, buyerTitlesFor(['SDR']))
})

const u = await table(['SDR'])
await ok('it takes the companies whose Buyer is empty, one no one was found at too; new titles keep the cells',
  async () => {
    const first = await saveOnly(u.rec())
    assert.ok('fail' in first && first.fail === 'over_ceiling', JSON.stringify(first))
    assert.equal(buyerOf(uid, u.rec()).added, true)
    setCells(u.sid, 0, { [B.search]: 'Found', [B.name]: 'Dana Kept' })
    setCells(u.sid, 1, { [B.search]: 'Not found', [B.name]: '' })
    const e = await estimate(u.rec())
    assert.ok('ok' in e && 'estimate' in e.ok, JSON.stringify(e))
    assert.equal(e.ok.estimate.rows_in_scope, 2)
    assert.deepEqual(e.ok.estimate.columns.map(c => c.rows), [2, 2])
    const again = await saveOnly(u.rec(), ['CRO'])
    assert.ok('fail' in again && again.fail === 'over_ceiling', JSON.stringify(again))
    assert.deepEqual([buyerOf(uid, u.rec()).titles, setups(u.sid, B.search).length], [['CRO'], 2])
    await saveOnly(u.rec(), ['cro'])
    assert.equal(setups(u.sid, B.search).length, 2)
    const kept = db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = 0').pluck().get(u.sid) as string
    assert.equal(JSON.parse(kept)[B.name], 'Dana Kept')
    setCells(u.sid, 1, { [B.name]: 'Sam' })
    setCells(u.sid, 2, { [B.name]: 'Lee' })
    const none = await estimate(u.rec())
    assert.ok('fail' in none && /has a Buyer already/.test(none.message), JSON.stringify(none))
  })

await ok('a renamed Buyer keeps its name: new titles save the search writing to it; the email reads it', async () => {
  const r = await renameSheetColumn(u.sid, uid, B.name, 'Decision maker')
  assert.ok('ok' in r, JSON.stringify(r))
  await saveOnly(u.rec(), ['VP Sales'])
  assert.ok(cols(u.sid).includes('Decision maker') && !cols(u.sid).includes(B.name), cols(u.sid).join(', '))
  const search = JSON.parse(setups(u.sid, B.search).at(-1)!.config)
  assert.deepEqual(search.responseMapping.find((m: { jsonPath: string }) => m.jsonPath === '$[0].name').columnName,
    'Decision maker')
  assert.equal(bodyOf(u.sid, B.emailSearch).full_name, '{{Decision maker}}')
  setCells(u.sid, 2, { 'Decision maker': '' })
  const e = await estimate(u.rec())
  assert.ok('ok' in e && 'estimate' in e.ok && e.ok.estimate.rows_in_scope === 1, JSON.stringify(e))
})

await ok('catch-all emails: off at first; choosing them saves the email setup again (balanced), cells kept; the same '
  + 'choice saves nothing; an agent without the write scope is refused before it changes', async () => {
  const c = await table(['SDR'])
  await saveOnly(c.rec())
  const strategy = () => JSON.parse(setups(c.sid, B.emailSearch).at(-1)!.config).enrichment.email.strategy
  assert.deepEqual([buyerOf(uid, c.rec()).catchAll, strategy(), setups(c.sid, B.emailSearch).length],
    [false, 'safest', 1])
  setCells(c.sid, 0, { [B.email]: 'kept@acme.com' })
  const denied = await findBuyers(uid, c.rec(), { titles: null, estimateOnly: false, maxCostUsd: 0.000001,
    canSave: false, catchAll: true })
  assert.ok('fail' in denied && denied.fail === 'forbidden', JSON.stringify(denied))
  assert.equal(setups(c.sid, B.emailSearch).length, 1)
  await findBuyers(uid, c.rec(), { titles: null, estimateOnly: false, maxCostUsd: 0.000001, catchAll: true })
  assert.deepEqual([buyerOf(uid, c.rec()).catchAll, strategy(), setups(c.sid, B.emailSearch).length],
    [true, 'balanced', 2])
  const kept = db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = 0').pluck().get(c.sid) as string
  assert.equal(JSON.parse(kept)[B.email], 'kept@acme.com')
  await saveOnly(c.rec())
  assert.equal(setups(c.sid, B.emailSearch).length, 2, 'left out: as saved, nothing saved again')
  await findBuyers(uid, c.rec(), { titles: null, estimateOnly: false, maxCostUsd: 0.000001, catchAll: false })
  assert.deepEqual([buyerOf(uid, c.rec()).catchAll, strategy()], [false, 'safest'])
})

await ok('columns of the same names in the way are named; roles that start no titles ask for them', async () => {
  const other = await table(['Chef'])
  const none = await estimate(other.rec())
  assert.ok('fail' in none && /Who buys\?/.test(none.message), JSON.stringify(none))
  db.prepare("UPDATE sheets SET column_order = json_insert(column_order, '$[#]', ?) WHERE id = ?")
    .run(B.title, other.sid)
  for (const out of [await estimate(other.rec(), ['Head Chef']), await saveOnly(other.rec(), ['Head Chef'])]) {
    assert.ok('fail' in out && out.message.includes(`"${B.title}"`), JSON.stringify(out))
  }
  assert.equal(setups(other.sid, B.search).length, 0)
})

done()
