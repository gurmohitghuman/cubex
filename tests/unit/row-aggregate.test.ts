// Over 200 lines: one fixture sheet shared by aggregates, picks and their checks, each against a JS reading.
// read_rows / REST rows/query extras on a migrated throwaway DB: group_by and
// aggregates (slice by slice, equal to a plain JavaScript count of the same
// rows), their refusals, the MCP answer's size cap, values taken out of JSON
// cells (columns with a path), starts_with / ends_with, and the grid's value
// counts (the view's other filters, the empty count apart).
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import selMod from '../../server/src/services/row-selection'
import groupsMod from '../../server/src/lib/row-aggregate/groups'
import specMod from '../../server/src/lib/row-aggregate/spec'
import pathsMod from '../../server/src/lib/row-select/paths'
import opsMod from '../../server/src/lib/row-filter/ops'
import valuesMod from '../../server/src/services/value-counts'
import schemaMod from '../../server/src/mcp/query-schema'
import constMod from '../../server/src/lib/constants-query'
import busyMod from '../../server/src/lib/sheet-busy'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { queryRows, parseRowQueryBody } = selMod as typeof import('../../server/src/services/row-selection')
const { GroupTally } = groupsMod as typeof import('../../server/src/lib/row-aggregate/groups')
const { parseAggregate } = specMod as typeof import('../../server/src/lib/row-aggregate/spec')
const { parseColumns, pickValue } = pathsMod as typeof import('../../server/src/lib/row-select/paths')
const { asNumber, foldText } = opsMod as typeof import('../../server/src/lib/row-filter/ops')
const { columnValueCounts } = valuesMod as typeof import('../../server/src/services/value-counts')
const { fitGroups } = schemaMod as typeof import('../../server/src/mcp/query-schema')
const { AGGREGATE_MAX_GROUPS, MCP_MAX_GROUP_CHARS } = constMod as typeof import('../../server/src/lib/constants-query')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
const COLUMNS = ['Industry', 'Country', 'Revenue', 'Score', 'Email', 'Response', 'Note']
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(COLUMNS))
const INDUSTRY = ['SaaS', ' saas ', 'SAAS', 'Fintech', 'Ünternehmen', 'ünternehmen', '', '  ', 'Retail']
const REVENUE = ['1,000', '2500', 'N/A', '', '-3.5', '1,5', '7']
const N = 30_000
const rows: Array<Record<string, string>> = []
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const data: Record<string, string> = {
      Industry: INDUSTRY[i % INDUSTRY.length], Country: ['DE', 'de', 'FR', 'US'][i % 4],
      Revenue: REVENUE[i % REVENUE.length], Score: String(i % 101), Email: i % 3 ? `p${i}@x.com` : '',
      Response: JSON.stringify({ data: { emails: [`a${i}@x.com`, `b${i}@x.com`], n: i,
        nested: { ok: i % 2 === 0 } } }),
      Note: i % 5 === 0 ? 'not json {' : `Acme ${i} GmbH`,
    }
    if (i % 11 === 0) delete data.Country
    rows.push(data)
    insert.run(uuid(), sid, uid, i * 2, JSON.stringify(data))
  }
})()

const query = async (body: Record<string, unknown>) => {
  const parsed = parseRowQueryBody(body, 500)
  if ('error' in parsed) return { fail: 'invalid', error: parsed.error } as const
  return queryRows(sid, uid, parsed.query)
}
type Group = { group: Record<string, string>; count: number; values?: Record<string, number | null> }
const groupsOf = async (body: Record<string, unknown>) => {
  const r = await query(body)
  assert.ok('ok' in r, JSON.stringify(r))
  return r.ok as { rows_matched: number; group_count: number; truncated: boolean; groups: Group[] }
}

// The JavaScript reading: fold keys, numbers as asNumber reads them.
function reference(by: string[], pass: (d: Record<string, string>) => boolean = () => true) {
  const out = new Map<string, { n: number; sum: number; num: number; min: number | null; filled: number }>()
  for (const d of rows.filter(pass)) {
    const key = JSON.stringify(by.map(c => foldText(d[c])))
    const g = out.get(key) ?? { n: 0, sum: 0, num: 0, min: null, filled: 0 }
    g.n++
    const v = asNumber(d.Revenue)
    if (v !== null) { g.sum += v; g.num++; g.min = g.min === null ? v : Math.min(g.min, v) }
    if (foldText(d.Email) !== '') g.filled++
    out.set(key, g)
  }
  return out
}

await check('group_by folds case and outer spaces; counts and aggregates equal a JS count over slices', async () => {
  const r = await groupsOf({ group_by: ['Industry', 'Country'], aggregates: [
    { op: 'sum', column: 'Revenue' }, { op: 'avg', column: 'Revenue' }, { op: 'min', column: 'Revenue' },
    { op: 'count', column: 'Email' }, { op: 'count' }] })
  const ref = reference(['Industry', 'Country'])
  assert.equal(r.rows_matched, N)
  assert.equal(r.group_count, ref.size)
  for (const g of r.groups) {
    const want = ref.get(JSON.stringify(['Industry', 'Country'].map(c => foldText(g.group[c]))))!
    assert.equal(g.count, want.n, JSON.stringify(g))
    assert.ok(Math.abs((g.values!['sum(Revenue)'] ?? 0) - want.sum) < 1e-6)
    assert.equal(g.values!['avg(Revenue)'], want.num ? want.sum / want.num : null)
    assert.equal(g.values!['min(Revenue)'], want.min)
    assert.equal(g.values!['count(Email)'], want.filled)
    assert.equal(g.values!.count, want.n)
  }
  assert.ok(r.groups.every((g, i) => i === 0 || r.groups[i - 1].count >= g.count), 'largest first')
})
await check('a group shows a value as written (the smallest, outer spaces off); an empty cell is the group ""',
  async () => {
  const r = await groupsOf({ group_by: ['Industry'] })
  const labels = r.groups.map(g => g.group.Industry)
  assert.deepEqual([...labels].sort(), ['', 'Fintech', 'Retail', 'SAAS', 'Ünternehmen'].sort())
  assert.equal(r.groups.find(g => g.group.Industry === 'SAAS')!.count, 3 * Math.ceil(N / 9))
  assert.equal(r.groups.find(g => g.group.Industry === '')!.count, 2 * (N / 9 | 0) + (N % 9 > 6 ? 1 : 0))
})
await check('aggregates over where, with no group_by: one group', async () => {
  const where = [{ column: 'Country', operator: 'eq', value: 'de' }]
  const r = await groupsOf({ where, aggregates: [{ op: 'max', column: 'Score' }, { op: 'count' }] })
  const want = rows.filter(d => foldText(d.Country) === 'de')
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].count, want.length)
  assert.equal(r.groups[0].values!['max(Score)'], Math.max(...want.map(d => Number(d.Score))))
  assert.deepEqual(r.groups[0].group, {})
})
await check('refusals say what to do', async () => {
  const err = async (body: Record<string, unknown>) => {
    const r = await query(body)
    return 'error' in r ? r.error : ''
  }
  assert.match(await err({ group_by: ['Industry'], cursor: 0 }), /answer groups, not rows/)
  assert.match(await err({ group_by: ['Industry'], columns: ['Email'] }), /answer groups, not rows/)
  assert.match(await err({ group_by: ['Nope'] }), /Unknown column\(s\): Nope/)
  assert.match(await err({ group_by: ['a', 'b', 'c', 'd'] }), /at most 3/)
  assert.match(await err({ aggregates: [{ op: 'sum' }] }), /sum needs a column/)
  assert.match(await err({ aggregates: [{ op: 'median', column: 'Score' }] }), /Unknown aggregate op "median"/)
  assert.match(await err({ aggregates: [{ op: 'count' }, { op: 'count' }] }), /asked for twice/)
  assert.match(await err({ group_by: ['Industry', 'Industry'] }), /twice/)
  assert.deepEqual(parseAggregate(undefined, undefined), { spec: null })
})
await check('past AGGREGATE_MAX_GROUPS different groups the read stops with a message', async () => {
  const tally = new GroupTally([])
  for (let i = 0; i < AGGREGATE_MAX_GROUPS; i++) {
    assert.ok(tally.add({ keys: [`k${i}`], labels: [`k${i}`], n: 1, m: [] }))
  }
  assert.equal(tally.add({ keys: ['one more'], labels: ['one more'], n: 1, m: [] }), false)
  assert.ok(tally.add({ keys: ['k5'], labels: ['K5'], n: 2, m: [] }), 'a group already held still counts')
})
await check('long values: cut for display, grouped by their whole text', () => {
  const tally = new GroupTally([])
  const a = 'x'.repeat(300) + 'a', b = 'x'.repeat(300) + 'b'
  tally.add({ keys: [a], labels: [a], n: 1, m: [] })
  tally.add({ keys: [b], labels: [b], n: 2, m: [] })
  const r = tally.result({ groupBy: ['C'], aggregates: [] }, 10)
  assert.equal(r.group_count, 2)
  assert.ok(r.groups.every(g => (g as { cut?: boolean }).cut && g.group.C.length === 201))
})
await check('an MCP answer keeps groups up to its character budget, then says truncated', () => {
  const groups = Array.from({ length: 2000 }, (_, i) => ({ group: { C: `value number ${i}` }, count: 1 }))
  const fit = fitGroups({ groups, truncated: false }) as { groups: unknown[]; truncated: boolean }
  assert.ok(fit.truncated && fit.groups.length < 2000)
  assert.ok(JSON.stringify(fit.groups).length <= MCP_MAX_GROUP_CHARS + 100)
  assert.equal((fitGroups({ groups: groups.slice(0, 3), truncated: false }) as { truncated: boolean }).truncated, false)
})

await check('columns can take a value out of a JSON cell by a path of keys', async () => {
  const r = await query({ limit: 3, columns: ['Industry',
    { column: 'Response', path: ['data', 'emails', 1], as: 'Second' },
    { column: 'Response', path: ['data', 'nested'] }, { column: 'Response', path: ['data', 'missing', 0] },
    { column: 'Note', path: ['x'] }] })
  assert.ok('ok' in r, JSON.stringify(r))
  const first = (r.ok.rows as Array<{ data: Record<string, unknown> }>)[0].data
  assert.deepEqual(first, { Industry: 'SaaS', Second: 'b0@x.com', 'Response.data.nested': { ok: true },
    'Response.data.missing.0': null, 'Note.x': null })
})
await check('path picks: shapes refused, values read safely', () => {
  const err = (raw: unknown) => { const r = parseColumns(raw); return 'error' in r ? r.error : '' }
  assert.match(err([{ column: 'R', path: [] }]), /1 to 5 keys/)
  assert.match(err([{ column: 'R', path: ['a', 'b', 'c', 'd', 'e', 'f'] }]), /1 to 5 keys/)
  assert.match(err([{ column: 'R', path: ['$.a'] }]) || 'ok', /ok/, 'a key with $ is just a key')
  assert.match(err([{ column: 'R', path: [-1] }]), /whole number/)
  assert.match(err([{ column: 'R', path: ['a'], as: 'R' }, 'R']), /both be named "R"/)
  assert.match(err([{ column: 'R', select: 'a' }]), /Unknown key "select"/)
  assert.deepEqual(parseColumns(['A', 'B']), { names: ['A', 'B'], picks: null })
  assert.equal(pickValue('{"a":{"__proto__":{"x":1}}}', ['a', 'x']), null)
  assert.equal(pickValue('[1,[2,3]]', [1, '0']), 2)
  assert.equal(pickValue(' {"a": [ {"b": "c"} ]} ', ['a', 0, 'b']), 'c')
  assert.equal(pickValue('{"constructor":1}', ['toString']), null)
  assert.equal(pickValue('plain text', ['a']), null)
})
await check('starts_with and ends_with through a read', async () => {
  const r = await query({ where: [{ column: 'Note', operator: 'starts_with', value: 'ACME 1' },
    { column: 'Note', operator: 'ends_with', value: '0 gmbh' }], return_mode: 'count' })
  assert.ok('ok' in r)
  assert.equal(r.ok.count, rows.filter(d => /^acme 1.*0 gmbh$/.test(foldText(d.Note))).length)
})

await check('value counts: the view\'s other filters apply, this column\'s own filter doesn\'t', async () => {
  db.prepare('UPDATE sheets SET column_filters = ?, empty_filter = ? WHERE id = ?').run(
    JSON.stringify({ Industry: { type: 'any_of', values: ['fintech'] }, Country: { type: 'eq', value: 'DE' } }),
    JSON.stringify({ Industry: 'not_empty' }), sid)
  const out = await columnValueCounts(sid, uid, 'Industry', undefined)
  assert.ok('ok' in out, JSON.stringify(out))
  const ref = reference(['Industry'], d => foldText(d.Country) === 'de')
  assert.equal(out.ok.rows, [...ref.values()].reduce((a, g) => a + g.n, 0))
  assert.equal(out.ok.empty, ref.get(JSON.stringify(['']))!.n)
  assert.deepEqual(out.ok.values.map(v => foldText(v.value)).sort(), ['fintech', 'retail', 'saas', 'ünternehmen'])
  assert.equal(out.ok.distinct, 4)
  db.prepare('UPDATE sheets SET column_filters = NULL, empty_filter = NULL WHERE id = ?').run(sid)
  const many = await columnValueCounts(sid, uid, 'Email', undefined)
  assert.ok('ok' in many && many.ok.truncated && many.ok.values.length === 1000 && many.ok.distinct === N - N / 3)
  assert.ok('fail' in await columnValueCounts(sid, uid, 'Nope', undefined))
})

await check('while a big job holds the sheet, counts answer busy instead of reading moving rows', async () => {
  let inside: unknown = null, picker: unknown = null
  await withSheetBusy(sid, 'sorting', async () => {
    inside = await query({ group_by: ['Industry'] })
    picker = await columnValueCounts(sid, uid, 'Industry', undefined)
  })
  assert.deepEqual(inside, { fail: 'busy', error: 'This sheet is busy sorting. Try again when that finishes.' })
  assert.ok(picker && 'busy' in (picker as object))
  // A job that starts during the count: busy too.
  const during = query({ group_by: ['Industry'] })
  await withSheetBusy(sid, 'importing', async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
  const after = await during
  assert.ok('fail' in after && after.fail === 'busy', JSON.stringify(after))
  assert.ok('ok' in await query({ group_by: ['Industry'] }))
})

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nAll row-aggregate assertions passed.')
