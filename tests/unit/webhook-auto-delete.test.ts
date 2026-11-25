// Auto-delete on a webhook sheet (services/webhook-auto-delete*.ts), its sweep run by hand on a throwaway
// database:
// A: what set accepts; a change keeps what it leaves out, null clears, unknown fields and a copy loop are refused.
// B: the newest keep_rows rows stay, older rows the webhook added are deleted with their results; rows it didn't
//    add stay; one History line.
// C: what holds a row: an auto-run column that hasn't run it (paused, by hand too, or not), one it was queued for
//    again, a ⏳ cell; the panel's waiting note.
// D: a success column; E: runs keep it out, and auto-run's own only for so long before the sheet yields.
// F: the copy to another sheet, a run there waits, a destination gone pauses; G: a full destination takes what
//    fits, then pauses.
// H: a sort pauses it until saved again; I: rows a clean, formula or lookup column still has to work out wait.
// J: the two hot queries use the sheet's index; K: 30,000 rows in slices, none holding the server 100 ms or more.
process.env.MAX_ROWS_PER_SHEET = '40000'
const { monitorEventLoopDelay } = await import('node:perf_hooks')
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { createSourceWithColumn } = await import('../../server/src/lib/webhook-service')
const { getSheetWebhook, setSheetWebhookAutoDelete, sheetWebhookView } =
  await import('../../server/src/services/sheet-webhook')
const { autoDeleteSweep } = await import('../../server/src/services/webhook-auto-delete-sweep')
const { NEWEST_LEAVING_SQL, windowSql } = await import('../../server/src/services/webhook-auto-delete-rows')
const { renameWebhookColumnRefs } = await import('../../server/src/lib/webhook-columns')
const { sheetYielding } = await import('../../server/src/lib/sheet-yield')
const { AUTO_DELETE_STARVED_MS } = await import('../../server/src/lib/constants')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')

function sheet(name: string, columns: string[]): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
    .run(id, tid, uid, name, JSON.stringify(columns))
  return id
}
function fill(sheetId: string, n: number, data: (i: number) => Record<string, string>, from = 0) {
  const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
  db.transaction(() => {
    for (let i = from; i < from + n; i++) insert.run(uuid(), sheetId, uid, i, JSON.stringify(data(i)))
  })()
}
// A webhook sheet with n rows the webhook added (its 📥 mark), after its marker column the given ones.
function webhookSheet(name: string, columns: string[], n: number, data: (i: number) => Record<string, string>) {
  const id = sheet(name, columns)
  const { source } = createSourceWithColumn(id, uid, name)
  const raw = source.raw_column_name
  fill(id, n, i => ({ [raw]: '📥 12:00:00', ...data(i) }))
  return { id, raw }
}
const left = (sheetId: string) =>
  db.prepare('SELECT row_index FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sheetId) as number[]
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const view = (sheetId: string) => {
  const got = getSheetWebhook(uid, sheetId)
  return 'ok' in got && got.ok ? sheetWebhookView(got.ok, null).auto_delete : undefined
}
const history = (sheetId: string) =>
  db.prepare('SELECT summary FROM sheet_changes WHERE sheet_id = ? ORDER BY id').pluck().all(sheetId) as string[]
const set = (sheetId: string, input: Record<string, unknown>) => setSheetWebhookAutoDelete(uid, sheetId, input)
function autorun(sheetId: string, column: string, watermark: number, paused: string | null = null): string {
  const id = uuid()
  db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, watermark_row_index,
    paused_reason) VALUES (?, ?, ?, ?, 'http', ?, ?)`).run(id, uid, sheetId, column, watermark, paused)
  return id
}
let clock = Date.now()
const sweep = async (ms = 10_000) => { clock += ms; await autoDeleteSweep(clock) }

// A: what set accepts.
{
  const { id, raw } = webhookSheet('Checks', ['Company'], 3, () => ({ Company: 'a' }))
  const other = sheet('Other', ['Company'])
  const refused = (input: Record<string, unknown>) => {
    const o = set(id, input)
    return 'fail' in o && o.fail === 'bad_request' ? o.message : null
  }
  check('A keep_rows -1, 1.5, "10" and 100,001 are refused',
    [-1, 1.5, '10', 100_001].every(k => refused({ keep_rows: k })))
  check('A a column the sheet lacks, or the webhook\'s own, is refused as the success column',
    !!refused({ success_column: 'Nope' }) && !!refused({ success_column: raw }))
  check('A copying to the sheet itself, or to an unknown sheet, is refused',
    !!refused({ copy_to_sheet_id: id }) && !!refused({ copy_to_sheet_id: uuid() }))
  check('A only the actions_finish mode', !!refused({ mode: 'rules' }))
  check('A an unknown field is refused, by name', refused({ keepRows: 5 }) === 'Unknown field: keepRows.')
  check('A off: auto_delete is null', view(id) === null)
  const on = set(id, {})
  check('A on with nothing given keeps 100 rows, no success column, no copy', 'ok' in on && same(view(id),
    { mode: 'actions_finish', where: null, keep_rows: 100, success_column: null, copy_to_sheet_id: null,
      copy_to_sheet: null, paused: null, waiting: null, rows_deleted: 0, last_deleted_at: null }), view(id))
  set(id, { keep_rows: 5, success_column: 'Company', copy_to_sheet_id: other })
  check('A the copy names its sheet', view(id)?.copy_to_sheet === 'Other', view(id))
  set(id, { keep_rows: 7 })
  check('A what a later set leaves out stays', view(id)?.keep_rows === 7 && view(id)?.success_column === 'Company'
    && view(id)?.copy_to_sheet_id === other, view(id))
  set(id, { success_column: null, copy_to_sheet_id: null })
  check('A null clears the success column and the copy', view(id)?.keep_rows === 7
    && view(id)?.success_column === null && view(id)?.copy_to_sheet_id === null, view(id))
  const back = webhookSheet('Back', ['Company'], 1, () => ({ Company: 'b' }))
  set(back.id, { copy_to_sheet_id: id })
  check('A a copy back to a sheet that copies here is refused',
    refused({ copy_to_sheet_id: back.id }) === '"Back" has auto-delete copying its rows back here.')
  check('A History says it was turned on, then changed', history(id).filter(h => h.includes('auto-delete')).length === 4
    && history(id).some(h => h.startsWith('Turned on auto-delete: it keeps the newest 100 rows; older rows the '
      + 'webhook added are deleted once every column with auto-run on has run on them')), history(id))
}

// B: no auto-run: everything the webhook added older than the newest 100 goes, with its results; typed rows stay.
{
  const { id, raw } = webhookSheet('Plain', ['Company'], 250, i => ({ Company: `c${i}` }))
  db.prepare('UPDATE rows SET data = ? WHERE sheet_id = ? AND row_index IN (3, 4)')
    .run(JSON.stringify({ [raw]: '', Company: 'typed' }), id)
  const run = uuid()
  db.prepare("INSERT INTO http_runs (id, sheet_id, user_id, status) VALUES (?, ?, ?, 'completed')").run(run, id, uid)
  for (const idx of [5, 200]) {
    db.prepare("INSERT INTO http_results (id, run_id, user_id, row_index, status) VALUES (?, ?, ?, ?, 'completed')")
      .run(uuid(), run, uid, idx)
  }
  set(id, {})
  const before = history(id).length
  await sweep()
  check('B the newest 100 stay; rows the webhook didn\'t add stay too', same(left(id), [3, 4, ...range(150, 250)]),
    left(id).slice(0, 4))
  check('B the count says 148', view(id)?.rows_deleted === 148 && !!view(id)?.last_deleted_at, view(id))
  const results = db.prepare('SELECT row_index FROM http_results WHERE run_id = ? ORDER BY row_index').pluck().all(run)
  check('B a deleted row\'s HTTP result goes; a kept one\'s stays', same(results, [200]), results)
  check('B nothing goes to the trash', db.prepare('SELECT COUNT(*) FROM trash_items').pluck().get() === 0)
  more(id, raw)
  await sweep()
  check('B one History line for every row it deleted, its count grown', same(history(id).slice(before),
    ['Auto-delete deleted 158 rows']), history(id).slice(before))
}
function more(sheetId: string, raw: string) {
  const top = left(sheetId).at(-1)!
  fill(sheetId, 10, i => ({ [raw]: '📥 12:00:02', Company: `n${i}` }), top + 1)
}

// C: auto-run columns hold the rows they haven't run, paused or not.
{
  const { id } = webhookSheet('Held', ['Company', 'Status', 'Paused', 'Capped'], 300, i => ({
    Company: `c${i}`, Status: i === 20 ? '⏳ Processing...' : 'done', Paused: 'x', Capped: 'x',
  }))
  autorun(id, 'Status', 149)
  const byHand = autorun(id, 'Paused', 99, 'user')
  const capped = autorun(id, 'Capped', 199, 'column_cap')
  autorun(id, 'Off', -1)
  db.prepare('UPDATE autorun_columns SET enabled = 0 WHERE sheet_id = ? AND status_column = ?').run(id, 'Off')
  const row10 = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND row_index = 10').pluck().get(id) as string
  db.prepare('INSERT INTO autorun_pending (autorun_id, user_id, row_id) VALUES (?, ?, ?)').run(capped, uid, row10)
  set(id, { keep_rows: 50 })
  await sweep()
  check('C rows past a watermark (paused by hand too), queued again or still ⏳ stay; auto-run off holds none',
    same(left(id), [10, 20, ...range(100, 300)]), left(id).slice(0, 5))
  check('C the panel says what they wait for', view(id)?.waiting === 'Auto-run on "Capped" is paused: rows wait '
    + 'until it has run them.', view(id))
  db.prepare('DELETE FROM autorun_pending WHERE row_id = ?').run(row10)
  db.prepare('UPDATE autorun_columns SET watermark_row_index = 299, paused_reason = NULL WHERE id IN (?, ?)')
    .run(byHand, capped)
  db.prepare("UPDATE autorun_columns SET watermark_row_index = 249 WHERE sheet_id = ? AND status_column = 'Status'")
    .run(id)
  await sweep()
  check('C once run and no longer queued they go', same(left(id), [20, ...range(250, 300)]), left(id).slice(0, 5))
  check('C nothing paused: no waiting note', view(id)?.waiting === null, view(id))
}

// D: a success column, which follows a rename; gone from the sheet, it pauses.
{
  const marks = ['ok', '❌ Failed: 500', '', '⏭️ Condition not met']
  const { id, raw } = webhookSheet('Sent', ['Company', 'Sent'], 200, i => ({ Company: `c${i}`, Sent: marks[i % 4] }))
  set(id, { keep_rows: 0, success_column: 'Sent' })
  await sweep()
  check('D only rows with a result there go (not failed, empty or skipped)',
    left(id).length === 150 && left(id).every(i => i % 4 !== 0), left(id).slice(0, 4))
  renameWebhookColumnRefs(id, uid, 'Sent', 'Sent 2')
  check('D a rename carries the success column', view(id)?.success_column === 'Sent 2')
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify([raw, 'Company']), id)
  const before = history(id).length
  await sweep()
  await sweep()
  check('D gone from the sheet: paused, and History says so once',
    /success column "Sent 2"/.test(view(id)?.paused ?? '') && history(id).length === before + 1,
    { paused: view(id)?.paused, lines: history(id).slice(before) })
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify([raw, 'Company', 'Sent 2']), id)
  await sweep()
  check('D back in the sheet: the pause clears', view(id)?.paused === null)
}

// E: a run keeps it out; auto-run's own runs only until AUTO_DELETE_STARVED_MS, then the sheet yields.
{
  const { id } = webhookSheet('Busy', ['Company'], 200, i => ({ Company: `c${i}` }))
  const run = uuid()
  db.prepare("INSERT INTO http_runs (id, sheet_id, user_id, status) VALUES (?, ?, ?, 'running')").run(run, id, uid)
  set(id, {})
  await sweep()
  check('E a person\'s run: nothing goes', left(id).length === 200)
  db.prepare("UPDATE http_runs SET autorun_id = 'auto' WHERE id = ?").run(run)
  await sweep(1_000)
  check('E an auto-run run: nothing goes, and the sheet doesn\'t yield yet',
    left(id).length === 200 && !sheetYielding(id, clock))
  await sweep(AUTO_DELETE_STARVED_MS)
  check('E kept out that long: the sheet yields, for less than a person\'s delete asks', sheetYielding(id, clock)
    && !sheetYielding(id, clock + 60_000))
  db.prepare("UPDATE http_runs SET status = 'paused' WHERE id = ?").run(run)
  check('E a paused run: the panel says so', view(id)?.waiting === 'A run on this sheet is paused: no row leaves '
    + 'until it is resumed or cancelled.', view(id))
  db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(run)
  await sweep()
  check('E the run done: they go', left(id).length === 100)
}

// F: copied first; a run there waits; a destination gone pauses it.
{
  const { id, raw } = webhookSheet('Leads', ['Company', 'Email'], 150,
    i => ({ Company: `c${i}`, Email: `e${i}@x.com` }))
  const archive = sheet('Archive', ['Company'])
  fill(archive, 1, () => ({ Company: 'old' }))
  const run = uuid()
  db.prepare("INSERT INTO http_runs (id, sheet_id, user_id, status) VALUES (?, ?, ?, 'running')").run(run, archive, uid)
  set(id, { copy_to_sheet_id: archive })
  await sweep()
  check('F a run in the archive: nothing goes, and no pause', left(id).length === 150 && view(id)?.paused === null,
    view(id))
  db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(run)
  await sweep()
  const copied = db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
    .all(archive) as string[]
  const rows = copied.map(d => JSON.parse(d))
  check('F 50 rows copied after the archive\'s own, in order', rows.length === 51 && rows[0].Company === 'old'
    && rows[1].Company === 'c0' && rows[50].Company === 'c49' && rows[50].Email === 'e49@x.com', rows.slice(0, 2))
  check('F the webhook\'s column stays behind; Email is added', rows.every(r => !(raw in r))
    && same(JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(archive) as string),
      ['Company', 'Email']))
  check('F and they left the webhook sheet', same(left(id), range(50, 150)))
  check('F the archive\'s History says where they came from',
    history(archive).includes('Auto-delete copied in 50 rows from "Leads"'), history(archive))
  more(id, raw)
  db.prepare('UPDATE sheets SET trash_id = 999 WHERE id = ?').run(archive)
  await sweep()
  check('F the archive in the trash: paused, nothing deleted', left(id).length === 110
    && /in the trash or was deleted/.test(view(id)?.paused ?? ''), view(id))
  db.prepare('UPDATE sheets SET trash_id = NULL WHERE id = ?').run(archive)
  await sweep()
  check('F restored: the pause clears and the 10 go', view(id)?.paused === null && left(id).length === 100)
}

// G: a full destination takes what fits, then pauses, once; it tries again a minute on.
{
  const { id } = webhookSheet('Many', ['Company'], 150, i => ({ Company: `c${i}` }))
  const full = sheet('Full', ['Company'])
  fill(full, 39_960, () => ({ Company: 'x' }))
  set(id, { copy_to_sheet_id: full })
  const before = history(id).length
  await sweep()
  await sweep(1_000)
  const count = () => db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(full) as number
  check('G 40 fit: copied and deleted; then paused', left(id).length === 110 && count() === 40_000
    && /"Full" is full \(40,000 rows\)/.test(view(id)?.paused ?? ''), { left: left(id).length, paused: view(id) })
  check('G History: the rows deleted, and the pause once', history(id).slice(before).length === 2,
    history(id).slice(before))
  db.prepare('DELETE FROM rows WHERE sheet_id = ? AND row_index < 100').run(full)
  await sweep(1_000)
  check('G within the minute it doesn\'t try again', left(id).length === 110)
  await sweep(60_000)
  check('G a minute on: room, so the rest go and the pause clears',
    left(id).length === 100 && view(id)?.paused === null)
}

// H: a sort (or an import) moves rows: paused until saved again.
{
  const { id } = webhookSheet('Sorted', ['Company'], 300, i => ({ Company: `c${i}` }))
  set(id, {})
  db.prepare('UPDATE sheets SET row_generation = row_generation + 1 WHERE id = ?').run(id)
  await sweep()
  check('H after a sort: paused, nothing deleted', left(id).length === 300
    && /sorted, imported or had duplicates removed/.test(view(id)?.paused ?? ''), view(id))
  set(id, {})
  await sweep()
  check('H saved again: the pause clears and they go', view(id)?.paused === null && left(id).length === 100)
}

// I: rows a clean, formula or lookup column still has to work out after a stopped run wait.
{
  const { id } = webhookSheet('Spans', ['Company', 'Formula'], 200, i => ({ Company: `c${i}`, Formula: 'x' }))
  const entry = autorun(id, 'Formula', 199)
  const span = Number(db.prepare("INSERT INTO derived_spans (user_id, sheet_id, rowids) VALUES (?, ?, '[]')")
    .run(uid, id).lastInsertRowid)
  db.prepare('INSERT INTO derived_span_marks (autorun_id, span_id) VALUES (?, ?)').run(entry, span)
  set(id, {})
  await sweep()
  check('I span work waiting: nothing goes', left(id).length === 200)
  db.prepare('DELETE FROM derived_span_marks WHERE autorun_id = ?').run(entry)
  await sweep()
  check('I worked out: they go', left(id).length === 100)
}

// J: the two queries a sweep makes on every sheet walk the sheet's index, never the sheet.
{
  const plan = (sql: string, args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as
    Array<{ detail: string }>).map(p => p.detail).join(' | ')
  const newest = plan(NEWEST_LEAVING_SQL, ['s', 'u', 5])
  const window = plan(windowSql(2), ['$.a', '$.b', 's', 'u', -1, 10, 100])
  for (const [name, steps] of [['newest', newest], ['window', window]]) {
    check(`J ${name}: the (sheet_id, user_id, row_index) index, no sort of its own`,
      /USING (COVERING )?INDEX sqlite_autoindex_rows_2 \(sheet_id=\? AND user_id=\?/.test(steps)
        && !/TEMP B-TREE/.test(steps),
      steps)
  }
}

// K: 30,000 rows with two auto-run columns, a success column and a copy, in slices.
{
  const n = 30_000
  const { id } = webhookSheet('Big', ['Company', 'A', 'B', 'Sent'], n, i => ({
    Company: `company ${i} `.repeat(8), A: 'done', B: 'done', Sent: 'ok',
  }))
  autorun(id, 'A', n)
  autorun(id, 'B', n)
  const archive = sheet('Big archive', [])
  set(id, { success_column: 'Sent', copy_to_sheet_id: archive })
  const delay = monitorEventLoopDelay({ resolution: 5 })
  delay.enable()
  const started = Date.now()
  let sweeps = 0
  while (left(id).length > 100 && sweeps < 20) { await sweep(); sweeps++ }
  delay.disable()
  const longest = delay.max / 1e6
  console.log(`K ${n - 100} rows in ${sweeps} sweeps, ${Date.now() - started} ms; `
    + `longest hold ${longest.toFixed(1)} ms`)
  check('K the newest 100 stay, in 6 sweeps of at most 5,000 rows', same(left(id), range(n - 100, n)) && sweeps === 6,
    { sweeps, left: left(id).length })
  const copied = db.prepare('SELECT json_extract(data, \'$.Company\') FROM rows WHERE sheet_id = ? ORDER BY row_index')
    .pluck().all(archive) as string[]
  check('K the archive has every row, in order', copied.length === n - 100
    && copied.every((c, i) => c.startsWith(`company ${i} `)), copied.length)
  check('K no slice held the server 100 ms', longest < 100, longest)
}

console.log(failures ? `${failures} FAILED` : 'all passed')
process.exitCode = failures ? 1 : 0
