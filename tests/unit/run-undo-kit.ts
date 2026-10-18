// Shared fixture for undoing a run's unit tests (run-undo, run-undo-jobs): a
// throwaway database migrated, one account and table, sheets of n rows, and a
// run that writes the way real ones do: ⏳ seeded in slices, then each row's
// result through writeRunCells, then stopped.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import busyMod from '../../server/src/lib/sheet-busy'
import cellsMod from '../../server/src/lib/placeholder-cells'
import writeMod from '../../server/src/lib/run-cells-write'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { seedProcessingPlaceholders, clearProcessingPlaceholders } =
  cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { writeRunCells } = writeMod as typeof import('../../server/src/lib/run-cells-write')

export function undoKit(name: string) {
  if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
  runMigrations()
  console.warn = () => {}
  const uid = uuid(), tid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
  let failures = 0
  const ok = async (label: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log('ok  ', label) }
    catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
  }
  const done = () => {
    if (failures > 0) { console.error(`${failures} ${name} assertion(s) failed`); process.exit(1) }
    console.log(`All ${name} assertions passed.`)
    process.exit(0)
  }
  const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }

  // A sheet of `rows` (one object of cells each) and its columns.
  const sheet = (rows: Array<Record<string, unknown>>, columns: string[]) => {
    const sid = uuid()
    db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
      .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(columns))
    const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    db.transaction(() => rows.forEach((r, i) => ins.run(uuid(), sid, uid, i, JSON.stringify(r))))()
    return sid
  }
  const cells = (sid: string, column: string) => (db.prepare(`SELECT json_extract(data, ?) FROM rows
    WHERE sheet_id = ? ORDER BY row_index`).pluck().all(`$."${column}"`, sid) as unknown[]).map(v => v ?? '')
  const edit = (sid: string, i: number, column: string, value: string) => db.prepare(`UPDATE rows
    SET data = json_set(data, ?, ?) WHERE sheet_id = ? AND row_index = ?`).run(`$."${column}"`, value, sid, i)

  // A run on `columns` (the first is its main one): seeded on every row, then
  // `results` (row index → its cells) written, then stopped as `status`.
  async function run(
    sid: string, kind: 'ai' | 'http', columns: string[],
    results: Record<number, string[]>, opts: { status?: string; stamp?: string } = {},
  ): Promise<string> {
    const id = uuid()
    if (kind === 'ai') {
      db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status) VALUES (?,?,?,?,'p','running')`)
        .run(id, sid, uid, columns[0])
    } else {
      db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
        VALUES (?,?,?,'{}','running',?)`).run(id, sid, uid, columns[0])
    }
    const last = db.prepare('SELECT MAX(row_index) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
    await seedProcessingPlaceholders({
      run: { kind, id }, sheetId: sid, userId: uid, columns, targets: null, lastRow: last, live: () => true,
    })
    db.transaction(() => {
      for (const [i, values] of Object.entries(results)) {
        const stamp = opts.stamp ? { path: opts.stamp, fp: `fp-${id.slice(0, 4)}` } : undefined
        writeRunCells({ kind, id }, sid, uid, Number(i), columns.map((c, k) => [c, values[k]]), stamp)
      }
    })()
    await clearProcessingPlaceholders(sid, uid, columns)
    const status = opts.status ?? 'completed'
    db.prepare(`UPDATE ${kind === 'ai' ? 'ai_runs' : 'http_runs'} SET status = ? WHERE id = ?`).run(status, id)
    return id
  }
  const journal = (kind: string, runId: string) => db.prepare(`SELECT * FROM run_undos WHERE run_kind = ?
    AND run_id = ?`).get(kind, runId) as { id: number; state: string; row_count: number; restored: number;
    skipped: number; gone: number; columns: string; created_at: string } | undefined
  const journalRows = (undoId: number) => db.prepare('SELECT COUNT(*) FROM run_undo_rows WHERE undo_id = ?')
    .pluck().get(undoId) as number
  return { db, uid, tid, ok, done, idle, sheet, cells, edit, run, journal, journalRows }
}
