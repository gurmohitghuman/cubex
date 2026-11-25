// Auto-delete's rules mode (services/webhook-auto-delete*.ts, migration 074), its sweep run by hand on a throwaway
// database:
// A: what set refuses in rules mode, and switching modes: what a change keeps, what it must clear on purpose, what
//    it clears; the rules in History in words.
// B: rows that pass the rules leave whether or not auto-run has run on them; rows that don't, rows still ⏳, rows
//    the webhook didn't add and the newest kept stay.
// C: a rule naming a column no longer in the sheet pauses it once; back, it clears. A rename carries into the
//    rules, and a new column with the old name isn't read by them.
// D: the window's read with real compiled rules (a group, any_of's json_each) still walks the sheet's index;
//    30,000 rows in slices, none holding the server 100 ms or more.
// E: a row in progress (➕ in a run column auto-run doesn't hold) stays; a column filling from stored answers makes
//    it wait, with no pause.
const { monitorEventLoopDelay } = await import('node:perf_hooks')
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { createSourceWithColumn } = await import('../../server/src/lib/webhook-service')
const { getSheetWebhook, setSheetWebhookAutoDelete, sheetWebhookView } =
  await import('../../server/src/services/sheet-webhook')
const { autoDeleteSweep } = await import('../../server/src/services/webhook-auto-delete-sweep')
const { windowSql } = await import('../../server/src/services/webhook-auto-delete-rows')
const { renameWebhookColumnRefs } = await import('../../server/src/lib/webhook-columns')
const { prepareWhere } = await import('../../server/src/services/row-filter')

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

// A webhook sheet with n rows the webhook added (its 📥 mark), after its marker column the given ones.
function webhookSheet(name: string, columns: string[], n: number, data: (i: number) => Record<string, string>) {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
    .run(id, tid, uid, name, JSON.stringify(columns))
  const raw = createSourceWithColumn(id, uid, name).source.raw_column_name
  const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
  db.transaction(() => {
    for (let i = 0; i < n; i++) insert.run(uuid(), id, uid, i, JSON.stringify({ [raw]: '📥 12:00:00', ...data(i) }))
  })()
  return { id, raw }
}
const left = (sheetId: string) =>
  db.prepare('SELECT row_index FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sheetId) as number[]
const view = (sheetId: string) => {
  const got = getSheetWebhook(uid, sheetId)
  return 'ok' in got && got.ok ? sheetWebhookView(got.ok, null).auto_delete : undefined
}
const history = (sheetId: string) =>
  db.prepare('SELECT summary FROM sheet_changes WHERE sheet_id = ? ORDER BY id').pluck().all(sheetId) as string[]
const set = (sheetId: string, input: Record<string, unknown>) => setSheetWebhookAutoDelete(uid, sheetId, input)
const refused = (sheetId: string, input: Record<string, unknown>) => {
  const o = set(sheetId, input)
  return 'fail' in o ? o.message : null
}
const LOW = [{ column: 'Score', operator: 'lt', value: '5' }]
let clock = Date.now()
const sweep = async (ms = 10_000) => { clock += ms; await autoDeleteSweep(clock) }

// A: refusals and switching modes.
{
  const { id } = webhookSheet('Modes', ['Score', 'Sent'], 3, i => ({ Score: String(i), Sent: 'ok' }))
  check('A an unknown mode is refused', refused(id, { mode: 'later' }) === 'mode is "actions_finish" or "rules".')
  check('A rules without where is refused',
    refused(id, { mode: 'rules' }) === 'Mode "rules" needs where: the rules a row must pass.')
  check('A where without rules is refused', refused(id, { where: LOW }) === 'where is for mode "rules".')
  check('A a rule on a column the sheet lacks is refused, naming it',
    /Nope/.test(refused(id, { mode: 'rules', where: [{ column: 'Nope', operator: 'empty' }] }) ?? ''))
  check('A rules all turned off are refused',
    /Every condition in where is turned off/.test(refused(id, { mode: 'rules',
      where: [{ column: 'Score', operator: 'empty', enabled: false }] }) ?? ''))
  check('A a success column with rules is refused', refused(id, { mode: 'rules', where: LOW, success_column: 'Sent' })
    === 'success_column is for mode "actions_finish". In rules, add a has_result rule on that column.')
  set(id, { success_column: 'Sent', keep_rows: 7 })
  check('A switching to rules with a success column set, without clearing it, is refused',
    /^Rows now wait for "Sent" to have a result, which rules don't\. Send success_column: null/.test(
      refused(id, { mode: 'rules', where: LOW }) ?? ''))
  set(id, { mode: 'rules', where: LOW, success_column: null })
  check('A cleared on purpose, the switch keeps keep_rows', view(id)?.mode === 'rules'
    && view(id)?.keep_rows === 7 && view(id)?.success_column === null
    && JSON.stringify(view(id)?.where) === JSON.stringify(LOW), view(id))
  set(id, { keep_rows: 9 })
  check('A a change in rules keeps the mode and the rules', view(id)?.mode === 'rules' && view(id)?.keep_rows === 9
    && JSON.stringify(view(id)?.where) === JSON.stringify(LOW), view(id))
  set(id, { mode: 'actions_finish' })
  check('A back to the first mode clears the rules', view(id)?.mode === 'actions_finish' && view(id)?.where === null,
    view(id))
  check('A History says the rules in words, and that a switch back cleared them',
    history(id).some(h => h.includes('older rows the webhook added are deleted once they pass its rules: "Score" lt '
      + '"5"')) && history(id).at(-1)!.endsWith('(its rules are cleared)'), history(id))
}

// B: rows that pass leave, whether or not auto-run has run on them.
{
  const { id, raw } = webhookSheet('Scores', ['Score', 'Status'], 200, i => ({
    Score: String(i % 10), Status: i === 2 ? '⏳ Processing...' : '',
  }))
  db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, watermark_row_index)
    VALUES (?, ?, ?, 'Status', 'http', -1)`).run(uuid(), uid, id)
  db.prepare('UPDATE rows SET data = ? WHERE sheet_id = ? AND row_index = 3')
    .run(JSON.stringify({ [raw]: '', Score: '3' }), id)
  set(id, { mode: 'rules', where: LOW, keep_rows: 50 })
  await sweep()
  const stay = left(id)
  const expected = Array.from({ length: 200 }, (_, i) => i).filter(i => i >= 150 || i % 10 >= 5 || i === 2 || i === 3)
  check('B rows under 5 go though auto-run ran none; ⏳, typed and the newest 50 stay',
    JSON.stringify(stay) === JSON.stringify(expected), { got: stay.slice(0, 8), want: expected.slice(0, 8) })
  check('B the count', view(id)?.rows_deleted === 200 - expected.length, view(id))
  check('B rules mode has no waiting note for the auto-run that ran none', view(id)?.waiting === null, view(id))
}

// C: a rule's column gone: paused once; back: cleared.
{
  const { id, raw } = webhookSheet('Gone', ['Score'], 100, i => ({ Score: String(i % 10) }))
  set(id, { mode: 'rules', where: LOW, keep_rows: 10 })
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify([raw]), id)
  const before = history(id).length
  await sweep()
  await sweep()
  check('C a rule\'s column gone: paused, nothing deleted, History once', left(id).length === 100
    && /^The rules can't be checked: .*Score/.test(view(id)?.paused ?? '') && history(id).length === before + 1,
    { paused: view(id)?.paused, lines: history(id).slice(before) })
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify([raw, 'Score']), id)
  await sweep()
  check('C back: the pause clears and they go', view(id)?.paused === null && left(id).length === 100 - 45,
    left(id).length)
  renameWebhookColumnRefs(id, uid, 'Score', 'Points')
  check('C a rename carries into the rules', JSON.stringify(view(id)?.where)
    === JSON.stringify([{ column: 'Points', operator: 'lt', value: '5' }]), view(id)?.where)
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify([raw, 'Points', 'Score']), id)
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Points', json_extract(data, '$.Score'), '$.Score', '0')
    WHERE sheet_id = ?`).run(id)
  await sweep()
  check('C a new column with the old name isn\'t read by them: nothing more goes', left(id).length === 55,
    left(id).length)
}

// D: the index, and 30,000 rows.
{
  const n = 30_000
  const rules = [{ or: [{ column: 'Score', operator: 'lt', value: '5' },
    { column: 'Company', operator: 'any_of', values: ['never'] }] }]
  // Twice, on two sheets: a slice over 100 ms on both is the code, not a busy machine.
  const runs: Array<{ longest: number; ok: boolean; sweeps: number }> = []
  for (const name of ['Big', 'Big again']) {
    const { id } = webhookSheet(name, ['Score', 'Company'], n, i => ({ Score: String(i % 10),
      Company: `company ${i} `.repeat(8) }))
    if (name === 'Big') {
      const prepared = prepareWhere(id, uid, rules as never)
      if ('error' in prepared) throw new Error(prepared.error)
      const steps = (db.prepare(`EXPLAIN QUERY PLAN ${windowSql(1, prepared.ok.filter.sql)}`)
        .all('$.a', ...prepared.ok.filter.params, id, uid, -1, 10, 100) as Array<{ detail: string }>)
        .map(p => p.detail).join(' | ')
      check('D the window with real rules walks the (sheet_id, user_id, row_index) index, no sort of its own',
        /USING (COVERING )?INDEX sqlite_autoindex_rows_2 \(sheet_id=\? AND user_id=\?/.test(steps)
          && !/TEMP B-TREE/.test(steps), steps)
    }
    set(id, { mode: 'rules', where: rules })
    const delay = monitorEventLoopDelay({ resolution: 5 })
    delay.enable()
    let sweeps = 0
    while (sweeps < 10) {
      const before = left(id).length
      await sweep()
      sweeps++
      if (left(id).length === before) break
    }
    delay.disable()
    const stay = left(id)
    runs.push({ longest: delay.max / 1e6, sweeps,
      ok: stay.length === n - Math.floor((n - 100) / 2) && stay.every(i => i >= n - 100 || i % 10 >= 5) })
    if (runs.at(-1)!.longest < 100) break
  }
  console.log(`D ${runs.map(r => `${r.sweeps} sweeps, longest hold ${r.longest.toFixed(1)} ms`).join('; ')}`)
  check('D every row under 5 older than the newest 100 went; the rest stayed', runs.every(r => r.ok), runs)
  check('D no slice held the server 100 ms', runs.some(r => r.longest < 100), runs)
}

// E: in progress, and filling.
{
  const { id } = webhookSheet('Lists', ['Score', 'Enrich'], 20,
    i => ({ Score: '1', Enrich: i === 4 ? '➕ Adding rows' : 'x' }))
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, status, master_column_name)
    VALUES (?, ?, ?, 'completed', 'Enrich')`).run(uuid(), id, uid)
  set(id, { mode: 'rules', where: LOW, keep_rows: 0 })
  await sweep()
  check('E ➕ in a run column auto-run doesn\'t hold: that row stays, the rest go', JSON.stringify(left(id)) === '[4]',
    left(id))
  const { id: filling } = webhookSheet('Filling', ['Score'], 20, () => ({ Score: '1' }))
  set(filling, { mode: 'rules', where: LOW, keep_rows: 0 })
  const job = uuid()
  db.prepare(`INSERT INTO enrichment_field_jobs (id, user_id, sheet_id, status_column, column_name, json_path)
    VALUES (?, ?, ?, 'Enrich', 'Score', '$.x')`).run(job, uid, filling)
  await sweep()
  check('E a column filling from stored answers: it waits, with no pause', left(filling).length === 20
    && view(filling)?.paused === null, view(filling))
  db.prepare("UPDATE enrichment_field_jobs SET status = 'done' WHERE id = ?").run(job)
  await sweep()
  check('E filled: they go', left(filling).length === 0, left(filling).length)
}

console.log(failures ? `${failures} FAILED` : 'all passed')
process.exitCode = failures ? 1 : 0
