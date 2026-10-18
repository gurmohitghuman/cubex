// Usage history (migration 033's run_usage, services/usage.ts and
// usage-csv.ts) against a migrated throwaway DB: the triggers keep each run's
// record (cells, AI cost, treg spend, status, its column through a rename and
// a delete) without the writers knowing; a sheet delete takes them with it;
// the read sums by column, day and run with totals over the whole range and
// reads the indexes; the backfill fills runs from before; the CSV has every
// row, escaped.
import { v4 as uuid } from 'uuid'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { readUsage, usageAsk } = await import('../../server/src/services/usage')
  const { writeUsageCsv } = await import('../../server/src/services/usage-csv')
  runMigrations()

  const uid = uuid(), tableId = uuid(), s1 = uuid(), s2 = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
  for (const [id, name] of [[s1, 'Leads'], [s2, 'Other']]) {
    db.prepare('INSERT INTO sheets (id, table_id, user_id, name) VALUES (?,?,?,?)').run(id, tableId, uid, name)
  }
  const usage = (runId: string) => db.prepare('SELECT * FROM run_usage WHERE run_id = ?').get(runId) as {
    kind: string; column_name: string | null; column_deleted: number; cells: number; ai_cost_usd: number;
    provider_cost_usd: number; enrich_micro: number; status: string; started_at: string
  } | undefined
  const aiRun = (sheet: string, column: string, at: string) => {
    const id = uuid()
    db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, created_at)
      VALUES (?,?,?,?,'p','deepseek/deepseek-v4-flash','running',?)`).run(id, sheet, uid, column, at)
    return id
  }
  const aiResult = (run: string, cost: number | null, provider: number | null = null) => db.prepare(`INSERT INTO
    ai_results (id, run_id, user_id, row_index, output_value, status, cost_usd, provider_cost_usd)
    VALUES (?,?,?,0,'x','completed',?,?)`).run(uuid(), run, uid, cost, provider)
  const httpRun = (sheet: string, column: string | null, at: string, enrichment: boolean) => {
    const id = uuid()
    const config = enrichment ? { enrichment: { v: 1, toolName: 'Work email' } } : { requestConfig: { url: 'x' } }
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, created_at)
      VALUES (?,?,?,?,'running',?,?)`).run(id, sheet, uid, JSON.stringify(config), column, at)
    return id
  }

  // --- The triggers -------------------------------------------------------------
  const a1 = aiRun(s1, 'Summary (Output)', '2026-10-05 10:00:00')
  check('a new AI run gets its record', usage(a1)?.kind === 'ai' && usage(a1)?.column_name === 'Summary (Output)')
  aiResult(a1, 0.002); aiResult(a1, 0.003, 0.01); aiResult(a1, null)
  db.prepare("UPDATE ai_runs SET processed_rows = 3, status = 'completed' WHERE id = ?").run(a1)
  const u1 = usage(a1)!
  check('its rows\' costs add up (OpenRouter and the own provider key apart)',
    near(u1.ai_cost_usd, 0.005) && near(u1.provider_cost_usd, 0.01))
  check('cells and status follow the run', u1.cells === 3 && u1.status === 'completed')
  db.prepare("DELETE FROM ai_results WHERE run_id = ?").run(a1)
  check('a cost stays when the rows (and their results) are deleted', near(usage(a1)!.ai_cost_usd, 0.005))
  db.prepare("UPDATE ai_runs SET column_name = 'Brief (Output)' WHERE id = ?").run(a1)
  check('a rename follows', usage(a1)?.column_name === 'Brief (Output)' && usage(a1)?.column_deleted === 0)
  db.prepare("UPDATE ai_runs SET column_name = ' deleted:Brief (Output)' WHERE id = ?").run(a1)
  check('a deleted AI column keeps its name, marked deleted',
    usage(a1)?.column_name === 'Brief (Output)' && usage(a1)?.column_deleted === 1)

  const e1 = httpRun(s1, 'Work email', '2026-10-06 09:00:00', true)
  const h1 = httpRun(s1, 'Lookup', '2026-10-06 11:00:00', false)
  check('an enrichment and an HTTP run are told apart', usage(e1)?.kind === 'enrichment' && usage(h1)?.kind === 'http')
  db.prepare('UPDATE http_runs SET spent_micro = 4500, processed_rows = 3 WHERE id = ?').run(e1)
  check('treg spend and cells follow the run', usage(e1)?.enrich_micro === 4500 && usage(e1)?.cells === 3)
  db.prepare('INSERT INTO enrich_run_reuse (run_id, user_id, reused_rows) VALUES (?,?,1)').run(e1, uid)
  db.prepare('UPDATE enrich_run_reuse SET reused_rows = reused_rows + 1 WHERE run_id = ?').run(e1)
  check('reused cells follow the run\'s count', (db.prepare('SELECT reused_cells FROM run_usage WHERE run_id = ?')
    .pluck().get(e1) as number) === 2)
  db.prepare('UPDATE http_runs SET master_column_name = NULL WHERE id = ?').run(h1)
  check('a deleted HTTP column keeps its name, marked deleted',
    usage(h1)?.column_name === 'Lookup' && usage(h1)?.column_deleted === 1)
  const e2 = httpRun(s1, 'Work email', '2026-10-07 09:00:00', true)
  db.prepare('UPDATE http_runs SET spent_micro = 500, processed_rows = 1 WHERE id = ?').run(e2)
  const a2 = aiRun(s1, 'Score', '2026-10-07 23:59:59')
  aiResult(a2, 0.01)
  db.prepare('UPDATE ai_runs SET processed_rows = 4 WHERE id = ?').run(a2)
  aiResult(aiRun(s1, 'Score', '2026-09-30 23:59:59'), 1)   // last month: outside October
  const other = aiRun(s2, 'Score', '2026-10-08 08:00:00')
  aiResult(other, 0.5)

  // --- The read -----------------------------------------------------------------
  const ask = (sheet: string | null, input: Record<string, unknown>) => {
    const out = usageAsk(uid, sheet, { from: '2026-10-01', to: '2026-10-31', ...input })
    if ('fail' in out) throw new Error(out.message)
    return readUsage(out.ok.scope, out.ok.query)
  }
  const byColumn = ask(s1, {})
  const totals = byColumn.totals
  check('totals cover the range on this sheet only (5 runs, 11 cells)', totals.runs === 5 && totals.cells === 11)
  check('... and add every kind of cost', near(totals.total_cost_usd, 0.005 + 0.01 + 0.01 + 0.005)
    && near(totals.enrichment_cost_usd, 0.005) && totals.reused_cells === 2)
  check('... with the cost per cell', near(totals.cost_per_cell_usd ?? 0, Math.round(0.03 / 11 * 1e8) / 1e8))
  const email = byColumn.rows.find(r => 'column' in r && r.column === 'Work email') as Record<string, unknown>
  check('a column sums its runs', email.runs === 2 && email.cells === 4 && near(email.total_cost_usd as number, 0.005)
    && email.kind === 'enrichment' && email.reused_cells === 2)
  const gone = byColumn.rows.filter(r => 'column_deleted' in r && r.column_deleted)
    .map(r => (r as { column: string }).column)
  check('deleted columns are listed too', gone.includes('Brief (Output)') && gone.includes('Lookup'))
  check('the costliest column comes first', (byColumn.rows[0] as { column: string }).column === 'Brief (Output)')
  const byDay = ask(s1, { group_by: 'day' })
  check('days, newest first, a run on the day it started',
    byDay.rows.map(r => (r as { day: string }).day).join() === '2026-10-07,2026-10-06,2026-10-05')
  const byRun = ask(s1, { group_by: 'run', limit: 2 })
  check('runs, newest first, a page of them', byRun.rows.length === 2 && byRun.rows_total === 5 && byRun.truncated
    && (byRun.rows[0] as { run_id: string }).run_id === a2)
  check('a run says what ran', (byRun.rows[0] as { what: string }).what === 'deepseek/deepseek-v4-flash'
    && (ask(s1, { group_by: 'run' }).rows.find(r => (r as { run_id: string }).run_id === e2) as { what: string })
      .what === 'Work email')
  check('the whole account adds the other sheet', ask(null, {}).totals.runs === 6)
  check('another sheet that isn\'t the user\'s is not found', 'fail' in usageAsk(uuid(), s1, {}))

  const plan = (sql: string, params: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as
    Array<{ detail: string }>).map(p => p.detail).join(' | ')
  const sheetPlan = plan(`SELECT COUNT(*) FROM run_usage u WHERE u.sheet_id = ? AND +u.user_id = ?
    AND u.started_at >= ? AND u.started_at < ?`, [s1, uid, 'a', 'b'])
  check('a sheet\'s read walks its index', sheetPlan.includes('idx_run_usage_sheet_time'))
  const userPlan = plan(`SELECT COUNT(*) FROM run_usage u
    WHERE u.user_id = ? AND u.started_at >= ? AND u.started_at < ?`, [uid, 'a', 'b'])
  check('the account\'s read walks its own', userPlan.includes('idx_run_usage_user_time'))

  // --- The CSV --------------------------------------------------------------------
  const csvOf = async (sheet: string, groupBy: string) => {
    let body = ''
    const headers: Record<string, string> = {}
    const res = {
      destroyed: false, setHeader: (k: string, v: string) => { headers[k] = v },
      write: (c: string) => { body += c; return true }, end: () => {}, once: () => {}, off: () => {},
    }
    const out = usageAsk(uid, sheet, { from: '2026-10-01', to: '2026-10-31', group_by: groupBy })
    if ('fail' in out) throw new Error(out.message)
    await writeUsageCsv(res as never, out.ok.scope, out.ok.query.groupBy, out.ok.name)
    return { lines: body.split('\r\n'), headers }
  }
  db.prepare("UPDATE ai_runs SET column_name = '=HYPERLINK(1)' WHERE id = ?").run(a2)
  const runs = await csvOf(s1, 'run')
  check('the CSV has a header and every run', runs.lines.length === 6 && runs.lines[0].startsWith('"Started (UTC)"'))
  check('... names that look like formulas stay text', runs.lines.some(l => l.includes('"\'=HYPERLINK(1)"')))
  const fileName = runs.headers['Content-Disposition']
  check('... and a file name', /Leads usage 2026-10-01 to 2026-10-31 by run\.csv/.test(fileName))
  const cols = await csvOf(s1, 'column')
  check('by column: one line a column', cols.lines.length === 1 + byColumn.rows_total)

  // --- A sheet delete keeps what its runs spent ---------------------------------------
  db.prepare('DELETE FROM sheets WHERE id = ?').run(s2)
  const account = ask(null, {})
  const lost = account.rows.find(r => (r as { sheet_id: string }).sheet_id === s2) as Record<string, unknown>
  check('a deleted sheet\'s spending stays in the account\'s history, marked',
    usage(other) !== undefined && account.totals.runs === 6 && lost.sheet_deleted === true && lost.sheet_name === null)

  // --- The backfill: a database from before 033 ---------------------------------------
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../server/src/db/migrations')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  const old = new Database(':memory:')
  old.pragma('foreign_keys = ON')
  for (const f of files.filter(f => f < '033')) old.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  old.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  old.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
  old.prepare('INSERT INTO sheets (id, table_id, user_id, name) VALUES (?,?,?,?)').run(s1, tableId, uid, 'Leads')
  old.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status, processed_rows)
    VALUES ('old-ai',?,?,' deleted:Notes','p','completed',2)`).run(s1, uid)
  old.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, cost_usd)
    VALUES ('r1','old-ai',?,0,'x','completed',0.25)`).run(uid)
  old.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, spent_micro)
    VALUES ('old-enrich',?,?,'{"enrichment":{"v":1}}','completed',NULL,700)`).run(s1, uid)
  old.prepare(`INSERT INTO enrichment_calls (id, user_id, sheet_id, run_id, status_column, tool_id, attempt,
    idempotency_key, created_at) VALUES ('c1',?,?,'old-enrich','Phone','t','t1','k','2026-10-01 00:00:00')`)
    .run(uid, s1)
  for (const f of files.filter(f => f >= '033')) old.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  const filled = old.prepare(`SELECT run_id, kind, column_name, column_deleted, ai_cost_usd, enrich_micro, cells
    FROM run_usage ORDER BY run_id`).all() as Array<Record<string, unknown>>
  check('runs from before get their records',
    filled.length === 2 && filled[0].kind === 'ai' && near(filled[0].ai_cost_usd as number, 0.25)
      && filled[0].column_name === 'Notes' && filled[0].column_deleted === 1 && filled[0].cells === 2)
  check('... a deleted enrichment column named from its ledger',
    filled[1].kind === 'enrichment' && filled[1].column_name === 'Phone' && filled[1].column_deleted === 1
      && filled[1].enrich_micro === 700)

  console.log(failures === 0 ? '\nall usage checks passed' : `\n${failures} FAILURES`)
  if (failures > 0) process.exit(1)
}
main().catch(e => { console.error(e); process.exit(1) })
