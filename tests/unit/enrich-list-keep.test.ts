// Keep-mode list runs (lib/enrich-list.ts `keep`, services/enrich-list-seen.ts,
// migration 061) against a migrated throwaway DB: the request parse and the
// duplicate key's other paths; a rerun adds only results the sheet never saw
// and moves nothing to the trash; a result seen again only moves its last-seen
// time; a row deleted since stays out; two source rows finding one result add
// it once; the seen table is written in the add's own transaction (a sheet
// with no room adds nothing and records nothing); an empty answer isn't
// journaled; recall keeps both options; replace mode as before.
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.MAX_ROWS_PER_SHEET = '40'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const L = await import('../../server/src/lib/enrich-list')
  const { parseListInput } = await import('../../server/src/lib/enrich-list-input')
  const { recallChoices } = await import('../../server/src/lib/enrich-run-recall')
  const { addListItems } = await import('../../server/src/services/enrich-list-add')
  const { writeEnrichmentResult } = await import('../../server/src/services/enrich-row-write')
  runMigrations()

  // --- Pure -------------------------------------------------------------------------
  const parsed = parseListInput({ dest: { newSheetName: 'Roles' }, provider: 'hirebase', maxItems: 5,
    fields: [{ path: '$.link', columnName: 'Link' }], dedupePath: '$.link', dedupeAlso: ['$.id', '$.id'], keep: true })
  check('keep and dedupeAlso parse (the paths once each)', typeof parsed === 'object' && parsed !== null
    && parsed.keep === true && JSON.stringify(parsed.dedupeAlso) === '["$.id"]')
  const bad = (v: Record<string, unknown>) => typeof parseListInput({ dest: { newSheetName: 'R' },
    fields: [{ path: '$.link', columnName: 'Link' }], ...v }) === 'string'
  check('dedupeAlso needs a dedupePath, takes paths only; keep is true or false',
    bad({ dedupeAlso: ['$.id'] }) && bad({ dedupePath: '$.link', dedupeAlso: ['$..id'] })
    && bad({ dedupePath: '$.link', dedupeAlso: '$.id' }) && bad({ keep: 'yes' }))
  check('left out, neither is set', (() => {
    const p = parseListInput({ dest: { newSheetName: 'R' } }) as Record<string, unknown>
    return !('keep' in p) && !('dedupeAlso' in p)
  })())
  const k = (item: unknown) => L.dedupeKey(item, '$.link', ['$.id'])
  check('the key: the link, else the id, both under the link\'s path',
    k({ link: 'u1', id: 'a' }) === L.dedupeKey({ link: 'u1' }, '$.link')
    && k({ id: 'a' }) !== null && k({ id: 'a' }) === k({ link: '', id: 'a' }) && k({}) === null)

  // --- Fixtures ---------------------------------------------------------------------
  const uid = uuid(), tableId = uuid(), src = uuid(), dest = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'Hiring')
  const sheet = db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  sheet.run(src, tableId, uid, 'Searches', JSON.stringify(['Role title', 'Roles found']))
  sheet.run(dest, tableId, uid, 'Roles', JSON.stringify(['Title', 'Link', 'Search']))
  const rowIds = [uuid(), uuid()]
  rowIds.forEach((id, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(id, src, uid, i, JSON.stringify({ 'Role title': ['SDR', 'BDR'][i], 'Roles found': '➕ Adding 3 rows…' })))
  const list = (keep: boolean) => ({
    destSheetId: dest, itemsPath: '$.output.jobs', provider: 'hirebase', maxItems: 10,
    fields: [{ path: '$.title', columnName: 'Title' }, { path: '$.link', columnName: 'Link' }],
    copy: [{ id: 'c1', from: 'Role title', to: 'Search' }],
    dedupe: { path: '$.link', also: ['$.id'] }, ...(keep ? { keep: true } : {}),
  })
  const run = (keep: boolean) => {
    const id = uuid()
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
      dest_sheet_id) VALUES (?, ?, ?, ?, 'completed', 0, 'Roles found', ?)`)
      .run(id, src, uid, JSON.stringify({ requestConfig: {}, responseMapping: [],
        enrichment: { v: 1, list: list(keep) } }), dest)
    return id
  }
  const job = (title: string, n: number) => ({ title, link: `https://jobs.example/${n}` })
  const journal = (runId: string, rowId: string, items: unknown[]) => {
    const id = uuid()
    db.prepare(`INSERT INTO enrichment_list_items (id, user_id, run_id, source_sheet_id, source_row_id,
      dest_sheet_id, items_json, item_count) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, uid, runId, src, rowId, dest, JSON.stringify({ items, copy: { c1: 'SDR' } }), items.length)
    return id
  }
  const links = () => (db.prepare(`SELECT json_extract(data, '$.Link') FROM rows WHERE sheet_id = ?
    ORDER BY row_index`).pluck().all(dest) as string[])
  const trashed = () => db.prepare('SELECT COUNT(*) FROM trash_items WHERE sheet_id = ?').pluck().get(dest) as number
  const seen = () => db.prepare('SELECT dedupe_key, first_run_id, last_seen_at FROM enrichment_list_seen WHERE '
    + 'dest_sheet_id = ? ORDER BY first_seen_at, dedupe_key').all(dest) as
    Array<{ dedupe_key: string; first_run_id: string; last_seen_at: string }>

  // --- Keep ---------------------------------------------------------------------------
  const r1 = run(true)
  const a1 = addListItems(journal(r1, rowIds[0], [job('SDR', 1), job('SDR', 2), { title: 'SDR', id: 'x9' }]))
  check('the first run adds every result and records each key it added', 'added' in a1 && a1.added === 3
    && links().length === 3 && seen().length === 3 && seen().every(s => s.first_run_id === r1))
  db.prepare("UPDATE enrichment_list_seen SET last_seen_at = '2026-01-01 00:00:00' WHERE dest_sheet_id = ?").run(dest)
  const r2 = run(true)
  // The run's write says the results are on their way, as a real one does.
  db.prepare(`UPDATE rows SET data = json_set(data, '$."Roles found"', '➕ Adding 3 rows…') WHERE id = ?`)
    .run(rowIds[0])
  const a2 = addListItems(journal(r2, rowIds[0], [job('SDR', 1), job('SDR', 3), { title: 'SDR', id: 'x9' }]))
  check('a rerun adds only the result never seen; the rows from before stay, none to the trash',
    'added' in a2 && a2.added === 1 && a2.skipped === 2 && links().length === 4 && trashed() === 0)
  const touched = seen().filter(s => s.last_seen_at !== '2026-01-01 00:00:00').length
  check('the results seen again (by link, and by id) move their last-seen time; the new one is recorded',
    seen().length === 4 && touched === 3)
  const cellOf = (rowId: string) => (JSON.parse(db.prepare('SELECT data FROM rows WHERE id = ?').pluck()
    .get(rowId) as string) as Record<string, string>)['Roles found']
  check('the source row says what it added', cellOf(rowIds[0]) === '✅ 1 row added, 2 already there')
  // The person deletes the row of https://jobs.example/2 (gone from rows, the trash emptied).
  db.prepare("DELETE FROM rows WHERE sheet_id = ? AND json_extract(data, '$.Link') = 'https://jobs.example/2'")
    .run(dest)
  const r3 = run(true)
  const a3 = addListItems(journal(r3, rowIds[0], [job('SDR', 2)]))
  check('a row deleted since stays out', 'added' in a3 && a3.added === 0 && !links().includes('https://jobs.example/2'))
  const r4 = run(true)
  addListItems(journal(r4, rowIds[0], [job('SDR', 5)]))
  const a4 = addListItems(journal(r4, rowIds[1], [job('BDR', 5), job('BDR', 6)]))
  check('two searches finding one role add it once', 'added' in a4 && a4.added === 1
    && links().filter(l => l === 'https://jobs.example/5').length === 1)
  // A sheet at its row limit (40): the results wait, nothing added, nothing recorded as seen.
  const filler = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  const before = seen().length
  const room = 40 - links().length
  for (let i = 0; i < room; i++) filler.run(uuid(), dest, uid, 1000 + i, '{}')
  const r5 = run(true)
  const a5 = addListItems(journal(r5, rowIds[0], [job('SDR', 7)]))
  check('no room: the results wait and nothing is recorded as seen', 'wait' in a5 && seen().length === before)
  db.prepare('DELETE FROM rows WHERE sheet_id = ? AND row_index >= 1000').run(dest)
  const a6 = addListItems(db.prepare("SELECT id FROM enrichment_list_items WHERE run_id = ?").pluck().get(r5) as string)
  check('with room again, the result is added and recorded', 'added' in a6 && a6.added === 1
    && seen().length === before + 1)

  // --- An empty answer, and recall -------------------------------------------------------
  const runRow = (id: string) => ({ id, sheet_id: src, user_id: uid, master_column_name: 'Roles found' })
  const empty = (runId: string) => {
    writeEnrichmentResult({
      run: runRow(runId) as never, generation: 0, rowIndex: 0,
      cells: { status: 'completed', statusCell: '⏭️ Not found', answer: {}, fill: 'all', reason: null },
      stored: { output: { jobs: [] } },
      mapping: [], costMicro: 0, request: {}, list: { items: [], copy: {}, rowId: rowIds[0] },
    })
    return db.prepare('SELECT COUNT(*) FROM enrichment_list_items WHERE run_id = ?').pluck().get(runId) as number
  }
  check('an empty answer of a keep run isn\'t journaled (it has nothing to remove)', empty(run(true)) === 0)
  check('one of a replace run is (it removes the rows from before)', empty(run(false)) === 1)
  const config = { requestConfig: {}, responseMapping: [], enrichment: {
    toolId: 'treg.companies.jobs.search', toolName: 'Jobs', preset: null, route: { prefer: [], exclude: [],
      stopAtFirst: true }, cleanDomains: false, fresh: true, maxCostPerRowUsd: null,
    rows: { mode: 'all', status: 'any', test: null, where: [] }, email: null, list: list(true),
  } }
  const recalled = recallChoices(config as never, 'Roles found').list
  check('recall keeps keep and the duplicate check\'s other paths', recalled?.keep === true
    && JSON.stringify(recalled.dedupeAlso) === '["$.id"]' && recalled.dedupePath === '$.link')

  // --- Replace mode, as before --------------------------------------------------------------
  const before2 = links().length
  const r7 = run(false)
  addListItems(journal(r7, rowIds[1], [job('BDR', 1)]))
  check('a replace run still skips a row that is there, and replaces its own rows on a rerun',
    links().length === before2 - 1 && !links().includes('https://jobs.example/6') && trashed() > 0)

  if (failures > 0) { console.error(`${failures} enrich-list-keep assertion(s) failed`); process.exit(1) }
  console.log('All enrich-list-keep assertions passed.')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
