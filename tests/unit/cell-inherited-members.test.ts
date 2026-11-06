// A column named like a member every object inherits reads its own cell. Row
// data is JSON.parse output: a row with no "constructor" key reads as an empty
// cell, not the inherited function, in auto-run's check, a waterfall's inputs,
// an enrichment's request, a list run's copied cells and an old condition list.
// And cells read as SQL picks keep a "__proto__" column's value (a plain
// object's setter dropped it) in a rule's scan, its seeding and a rerun's
// kept-out rows. Rows holding their keys read what they did.
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}
const attempt = <T>(f: () => T): T | string => { try { return f() } catch (e) { return `threw ${String(e)}` } }

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { candidateVerdict } = await import('../../server/src/lib/autorun-rules')
const { inputValues } = await import('../../server/src/lib/waterfall/inputs')
const { fillTemplate } = await import('../../server/src/lib/enrich-request')
const { copyValues } = await import('../../server/src/lib/enrich-list')
const { passesRunConditions } = await import('../../server/src/lib/enrich-seed')
const { checkRule } = await import('../../server/src/lib/run-condition')
const { scanRule } = await import('../../server/src/services/run-condition-rows')
const { seedPlaceholdersByRule } = await import('../../server/src/lib/placeholder-rule-seed')
const { chooseRerunTargets } = await import('../../server/src/services/rerun-targets')
const { CONDITION_NOT_MET } = await import('../../server/src/lib/run-markers')
runMigrations()

const row = (json: string) => JSON.parse(json) as Record<string, string>
const without = row('{"Out":""}')

// --- Reads of a row's data ----------------------------------------------------------
const plan = (col: string) => ({
  kind: 'http' as const, statusColumn: 'Out', columns: [col, 'Out'], where: [], rule: null, requestCols: [col],
  config: {
    requestConfig: { method: 'GET', url: `https://x.test/{{${col}}}`, headers: {} }, responseMapping: [],
  } as never,
})
check('auto-run: a row without the "constructor" key waits for it (no TypeError)',
  attempt(() => candidateVerdict(without, plan('constructor'), false)) === 'waiting',
  attempt(() => candidateVerdict(without, plan('constructor'), false)))
check('... one holding it is taken, as before', candidateVerdict(row('{"constructor":"c"}'), plan('constructor'), false)
  === 'take')
check('auto-run: a "__proto__" input holding a value is taken',
  candidateVerdict(row('{"__proto__":"p"}'), plan('__proto__'), false) === 'take')

const fromColumn = (r: Record<string, string>) => inputValues({ k: '{{constructor}}' }, r, [], ['k'], ['constructor']).k
check('a waterfall input from a row without the key is empty, not the function\'s source',
  fromColumn(without) === '', fromColumn(without))
check('... and a row holding it sends its value', fromColumn(row('{"constructor":" c "}')) === 'c')

const filled = (r: Record<string, string>) => fillTemplate('id={{constructor}}', r, ['constructor'])
check('an enrichment request reads an empty cell for a row without the key',
  JSON.stringify(filled(without)) === '{"value":"id="}', filled(without))
check('... and the value of a row holding it',
  JSON.stringify(filled(row('{"constructor":"c"}'))) === '{"value":"id=c"}')

const list = { copy: [{ id: 'c1', from: 'constructor', to: 'C' }, { id: 'c2', from: 'Out', to: 'O' }] } as never
check('a list run copies an empty cell from a row without the key (no TypeError)',
  JSON.stringify(attempt(() => copyValues(list, without))) === '{"c1":"","c2":""}',
  attempt(() => copyValues(list, without)))
check('... and the value of a row holding it',
  JSON.stringify(copyValues(list, row('{"constructor":"c","Out":"o"}'))) === '{"c1":"c","c2":"o"}')

const notEmpty = [{ column: 'constructor', op: 'not_empty' as const, value: '' }]
check('an old condition list: "constructor is not empty" fails on a row without the key',
  passesRunConditions(without, notEmpty, null) === false)
check('... and passes on a row holding a value', passesRunConditions(row('{"constructor":"c"}'), notEmpty, null))

// --- Cells read as SQL picks ----------------------------------------------------------
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
const columns = ['__proto__', 'constructor', 'Out']
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
  .run(sid, tid, uid, 'S', JSON.stringify(columns))
const setRows = (rows: string[]) => {
  db.prepare('DELETE FROM rows WHERE sheet_id = ?').run(sid)
  const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
  rows.forEach((data, i) => insert.run(uuid(), sid, uid, i, data))
}
const outCells = () => (db.prepare(`SELECT json_extract(data, '$.Out') FROM rows WHERE sheet_id = ? ORDER BY row_index`)
  .pluck().all(sid) as string[])
const rule = checkRule('{{__proto__}} is "x"', columns)

setRows(['{"__proto__":"x","Out":""}', '{"__proto__":"y","Out":""}'])
const scan = await scanRule({ sheetId: sid, userId: uid, tree: rule.tree, columns: rule.columns, keepPassing: 5,
  keepFirst: 5 })
check('a rule scan reads a "__proto__" column\'s value', scan.passing === 1 && scan.passingRows.join() === '0'
  && JSON.stringify(scan.firstRows.map(r => r.values)) === '[{"__proto__":"x"},{"__proto__":"y"}]', scan)

const run = uuid()
db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
  VALUES (?, ?, ?, '{}', 'running', 'Out')`).run(run, sid, uid)
await seedPlaceholdersByRule({ run: { kind: 'http', id: run }, sheetId: sid, userId: uid, columns: ['Out'],
  rule: { tree: rule.tree, columns: rule.columns, markColumn: 'Out' }, targets: null, lastRow: 1, live: () => true })
check('seeding by the rule runs the row whose "__proto__" passes it and keeps the other out',
  outCells().join('|') === `⏳ Processing...|${CONDITION_NOT_MET}`, outCells())

setRows([`{"__proto__":"x","Out":"${CONDITION_NOT_MET}"}`, `{"__proto__":"y","Out":"${CONDITION_NOT_MET}"}`])
const taken = await chooseRerunTargets(sid, uid, 'Out', () => true, {}, rule)
check('a rerun takes a kept-out row once its "__proto__" passes the rule', taken.join() === '0', taken)

console.log(failures === 0 ? '\ncell inherited members: all passed' : `\ncell inherited members: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
