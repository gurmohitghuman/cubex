// Auto-run against a migrated throwaway DB: which rows it takes (inputs, status,
// "Only run if", run markers), the columns a request reads, markAutorunInputs
// (only enabled auto-runs whose inputs were written, only rows not run yet),
// the watermark kept exact by deletes, sorts and CSV replaces, today's caps,
// an own-key column's cap, a deleted HTTP input, and the test clock.
// Over 200 lines: one script over one sheet's fixtures; split, each part would rebuild them.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const CLOCK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clock-')), 'offset')
process.env.CUBEX_TEST_CLOCK_FILE = CLOCK

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const rules = await import('../../server/src/lib/autorun-rules')
  const mark = await import('../../server/src/lib/autorun-mark')
  const cap = await import('../../server/src/services/autorun-capacity')
  const clock = await import('../../server/src/lib/clock')
  runMigrations()

  // --- Which rows a plan takes ---------------------------------------------------
  const http = {
    kind: 'http' as const, statusColumn: 'Push', columns: ['Email', 'Name', 'Push', 'Email status'],
    config: { requestConfig: { method: 'POST', url: 'https://x.test/{{Email}}', headers: {}, body: '{"n":"{{Name}}"}' },
      responseMapping: [] } as never,
    requestCols: ['Email', 'Name'], where: [{ column: 'Email status', op: 'eq' as const, value: 'valid' }],
  }
  const row = (o: Record<string, string>) => ({ Email: 'a@b.co', Name: 'Ada', 'Email status': 'valid', ...o })
  const v = (o: Record<string, string>, failed = false) => rules.candidateVerdict(row(o), http, failed)
  check('a row with its inputs and no status is taken', v({}) === 'take')
  check('a row that ran (✅) is left alone', v({ Push: '✅ Success' }) === 'done')
  check('a ❌ row waits, unless an input was just written', v({ Push: '❌ Error' }) === 'done'
    && v({ Push: '❌ Error' }, true) === 'take')
  check('a ⏳ row is running: left alone', v({ Push: '⏳ Processing...' }) === 'done')
  check('an empty input waits', v({ Name: ' ' }) === 'waiting')
  check('"Only run if" failing waits', v({ 'Email status': 'invalid' }) === 'waiting')
  check("another run's markers are not inputs", v({ Email: '⏳ Processing...' }) === 'waiting'
    && v({ Email: '❌ Error: timeout' }) === 'waiting' && v({ Email: '⏭️ No data' }) === 'waiting')
  check('"⏭️ Condition not met" has not run: taken once it passes, a real ⏭️ result never',
    v({ Push: ' ⏭️ Condition not met ' }) === 'take' && v({ Push: '⏭️ Not found' }) === 'done'
    && v({ Push: '⏭️ Condition not met', 'Email status': 'invalid' }) === 'waiting')

  const enrich = {
    ...http, kind: 'enrichment' as const, statusColumn: 'Work email', where: [], requestCols: ['Name', 'Website'],
    columns: ['Name', 'Website', 'Work email'],
    config: {
      requestConfig: {
        method: 'POST', url: 'x', headers: {}, body: JSON.stringify({ full_name: '{{Name}}', domain: '{{Website}}' }),
      },
      responseMapping: [],
      enrichment: { v: 1, cleanDomains: true, toolSnapshot: {
        id: 'treg.people.email.find', method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null,
        inputs: [{ name: 'full_name', in: 'body', type: 'string', required: true },
          { name: 'domain', in: 'body', type: 'string', required: true }],
      } },
    } as never,
  }
  check('an enrichment row with its inputs is taken',
    rules.candidateVerdict({ Name: 'Ada', Website: 'stripe.com' }, enrich, false) === 'take')
  check('an enrichment row missing a required input waits',
    rules.candidateVerdict({ Name: 'Ada', Website: '' }, enrich, false) === 'waiting')
  check('enrichment inputs: the columns its templates name',
    rules.requestColumns(enrich.config, enrich.columns).join() === 'Name,Website')
  check('HTTP inputs: tokens that are columns (any case); saved keys are not',
    rules.requestColumns({
      requestConfig: { method: 'GET', url: 'https://x.test/{{email}}?k={{my_key}}', headers: { A: '{{Name}}' } },
      responseMapping: [],
    } as never, ['Email', 'Name']).sort().join() === 'Email,Name')
  check('the 409 names auto-run', rules.autorunBusyMessage('enrichment', 'Work email', 12)
    === 'Auto-run is enriching 12 rows in Work email. Try again in a moment, or pause auto-run.')

  // --- markAutorunInputs ---------------------------------------------------------
  const uid = uuid(), tableId = uuid(), sheetId = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'Leads')
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(sheetId, tableId, uid, 'S', JSON.stringify(['Name', 'Website', 'Work email', 'Notes']))
  const ids: string[] = []
  const statuses = ['', '✅ Valid', '❌ Bad input', '', '']
  statuses.forEach((st, i) => {
    const id = uuid(); ids.push(id)
    db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
      .run(id, sheetId, uid, i, JSON.stringify({ Name: `N${i}`, Website: '', 'Work email': st }))
  })
  const entry = (column: string, inputs: string[], enabled = 1, w = 4) => {
    const id = uuid()
    db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, enabled, input_columns,
      watermark_row_index) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, uid, sheetId, column, 'enrichment', enabled, JSON.stringify(inputs), w)
    return id
  }
  const on = entry('Work email', ['Name', 'Website'])
  const off = entry('Other', ['Website'], 0)
  const pending = (id: string) =>
    db.prepare('SELECT row_id FROM autorun_pending WHERE autorun_id = ?').pluck().all(id) as string[]
  db.transaction(() => mark.markAutorunInputs(sheetId, uid, ['Notes'], { indexes: [0, 1, 2, 3] }))()
  check('a column no auto-run reads queues nothing', pending(on).length === 0)
  db.transaction(() => mark.markAutorunInputs(sheetId, uid, ['Website'], { indexes: [0, 1, 2] }))()
  const q = pending(on)
  check('an input written queues the rows not run yet (empty or ❌), never a ✅ row',
    q.length === 2 && q.includes(ids[0]) && q.includes(ids[2]) && !q.includes(ids[1]))
  check('an auto-run that is off queues nothing', pending(off).length === 0)
  db.transaction(() => mark.markAutorunEdits(sheetId, uid,
    [{ column: 'Notes', rowId: ids[3] }, { column: 'Name', rowId: ids[4] }]))()
  check('a batch of edits queues a row only for the columns written in it',
    pending(on).includes(ids[4]) && !pending(on).includes(ids[3]))
  // An "Only run if" kept row 3 out of a run; row 4 ran and found nothing.
  const setStatus = (id: string, st: string) =>
    db.prepare(`UPDATE rows SET data = json_set(data, '$."Work email"', ?) WHERE id = ?`).run(st, id)
  setStatus(ids[3], '⏭️ Condition not met'); setStatus(ids[4], '⏭️ Not found')
  db.prepare('DELETE FROM autorun_pending WHERE autorun_id = ?').run(on)
  db.transaction(() => mark.markAutorunInputs(sheetId, uid, ['Website'], { indexes: [3, 4] }))()
  const kept = pending(on)
  db.prepare('DELETE FROM autorun_pending WHERE autorun_id = ?').run(on)
  db.transaction(() => mark.markAutorunEdits(sheetId, uid,
    [{ column: 'Name', rowId: ids[3] }, { column: 'Name', rowIndex: 4 }]))()
  check('"⏭️ Condition not met" is queued again when an input is written, a real ⏭️ result is not',
    kept.join() === ids[3] && pending(on).join() === ids[3])

  // --- The watermark -------------------------------------------------------------
  const wOf = () => db.prepare('SELECT watermark_row_index FROM autorun_columns WHERE id = ?').pluck().get(on) as number
  db.prepare('DELETE FROM rows WHERE sheet_id = ? AND row_index IN (3, 4)').run(sheetId)
  db.transaction(() => mark.autorunRowsRemoved(sheetId, uid))()
  check('a tail delete lowers the fence, so an append reusing row 3 is new', wOf() === 2)
  const appended = uuid(), keptOut = uuid(), notFound = uuid()
  const addRow = (id: string, i: number, data: object) => db.prepare(
    'INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)',
  ).run(id, sheetId, uid, i, JSON.stringify(data))
  addRow(appended, 3, {}); addRow(keptOut, 4, { 'Work email': '⏭️ Condition not met' })
  addRow(notFound, 5, { 'Work email': '⏭️ Not found' })
  db.prepare('UPDATE autorun_columns SET watermark_row_index = 0 WHERE id = ?').run(on)
  db.prepare('DELETE FROM autorun_pending').run()
  const rows = db.prepare('SELECT rowid, row_index FROM rows WHERE sheet_id = ? ORDER BY row_index')
    .raw().all(sheetId) as Array<[number, number]>
  await mark.autorunKeepUnswept(sheetId, uid, rows.map(r => r[0]), rows.map(r => r[1]))
  check('a sort keeps the rows not swept yet (above the fence) by id, only those not run (✅, ❌, ⏭️ stay out)',
    pending(on).sort().join() === [appended, keptOut].sort().join())
  mark.autorunAfterReorder(sheetId, uid, rows.length)
  check('after the sort the fence is the sorted count', wOf() === rows.length - 1)
  mark.autorunAfterReplace(sheetId, uid, null)
  check('a CSV replace makes every row new and empties the queue', wOf() === -1 && pending(on).length === 0)
  db.transaction(() => mark.markAutorunInputs(sheetId, uid, ['Website'], { indexes: [0, 3] }))()
  const queued = pending(on).length
  await mark.autorunDropPending(sheetId, uid, on)
  check('the queue drops in slices before a replace or a fresh turn-on', queued === 2 && pending(on).length === 0)

  // --- Today's caps --------------------------------------------------------------
  const block = (enrich.config as never as { enrichment: object }).enrichment
  const cfg = { ...enrich.config, enrichment: { ...block, maxCostPerRowUsd: 0.01 } }
  const e = () => db.prepare('SELECT * FROM autorun_columns WHERE id = ?').get(on) as never
  db.prepare('UPDATE autorun_columns SET daily_cap_micro = 50000 WHERE id = ?').run(on)
  const room = cap.autorunCapacity(e(), cfg as never)
  check('room: the column cap over the per-row cap', 'rows' in room && room.rows === 5 && room.runLimitUsd === 0.05)
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, status, master_column_name, autorun_id, autorun_day,
    spent_micro) VALUES (?,?,?,?,?,?,?,?)`)
    .run(uuid(), sheetId, uid, 'completed', 'Work email', on, clock.utcDay(), 45000)
  const full = cap.autorunCapacity(e(), cfg as never)
  check("today's spend fills the column cap", 'reason' in full && full.reason === 'column_cap')
  db.prepare('INSERT INTO settings (id, user_id, enrich_daily_limit_micro) VALUES (?,?,?)').run(uuid(), uid, 30000)
  db.prepare('UPDATE autorun_columns SET daily_cap_micro = 1000000 WHERE id = ?').run(on)
  db.prepare('INSERT INTO enrich_daily_spend (user_id, day, spent_micro) VALUES (?,?,?)')
    .run(uid, clock.utcDay(), 25000)
  const limited = cap.autorunCapacity(e(), cfg as never)
  check('the daily limit for all enrichments stops it too', 'reason' in limited && limited.reason === 'daily_limit')

  // --- An own-key tool (no listed price) ------------------------------------------
  const settings = await import('../../server/src/services/autorun-settings')
  const ownKey = { ...enrich.config, enrichment: { ...block, maxCostPerRowUsd: null } }
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, status, master_column_name, config)
    VALUES (?,?,?,?,?,?)`).run(uuid(), sheetId, uid, 'completed', 'Work email', JSON.stringify(ownKey))
  const saveCap = (dailyCapUsd: number | null) => settings.saveAutorunSettings(uid, sheetId,
    { column: 'Work email', enabled: true, where: null, dailyCapUsd, dailyRowCap: null }, { hasSecretsScope: true })
  const capNow = () => db.prepare('SELECT daily_cap_micro FROM autorun_columns WHERE id = ?').pluck().get(on)
  const saved = await saveCap(null)
  check('an own-key column saved without a cap has none', 'ok' in saved && capNow() === null)
  await saveCap(3)
  check('... and keeps one given (for when treg prices it), clamped to the daily limit', capNow() === 30000)

  // --- A deleted input keeps an HTTP auto-run paused --------------------------------
  // Its request's token for the deleted column would read as plain text, so the
  // tick must still see the column as gone (it watched it before).
  const loop = await import('../../server/src/services/autorun-loop')
  const cols = await import('../../server/src/lib/autorun-columns')
  const hSheet = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(hSheet, tableId, uid, 'H', JSON.stringify(['Email', 'Name', 'Push']))
  const push = { requestConfig: { method: 'POST', url: 'https://x.test/leads', headers: {},
    body: '{"email":"/Email","name":"{{Name}}"}' }, responseMapping: [] }
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
    VALUES (?,?,?,?,'completed','Push')`).run(uuid(), hSheet, uid, JSON.stringify(push))
  const hId = uuid()
  db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, input_columns,
    watermark_row_index) VALUES (?,?,?,?,?,?,?)`).run(hId, uid, hSheet, 'Push', 'http', '["Email","Name"]', -1)
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['Name', 'Push']), hSheet)
  cols.deleteAutorunColumnRefs(hSheet, uid, 'Email')
  await loop.autorunTick(hId)
  const hAfter = db.prepare('SELECT paused_reason, input_columns FROM autorun_columns WHERE id = ?').get(hId) as
    { paused_reason: string | null; input_columns: string }
  check('a deleted HTTP input keeps its auto-run paused after a tick',
    hAfter.paused_reason === 'missing_input' && hAfter.input_columns === '["Email","Name"]')

  // --- The test clock (CUBEX_TEST_CLOCK_FILE) -----------------------------------
  const today = clock.utcDay()
  fs.writeFileSync(CLOCK, String(24 * 3600 * 1000))
  await new Promise(r => setTimeout(r, 600))
  check('the test clock moves today forward', clock.utcDay() !== today)
  const tomorrow = cap.autorunCapacity(e(), cfg as never)
  check('after midnight UTC the caps allow rows again', 'rows' in tomorrow && tomorrow.rows > 0)
  fs.rmSync(CLOCK)

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nall auto-run checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })
