// A list job that also fills the asking row, against a migrated throwaway DB:
// the pure parts (the row's cells and status words, what may be reused, fixed
// values, a results path the example shows empty), then the writes (outputs
// written with the journal row; an answer with no results journaled only when
// the row added rows before, and the drain replacing those with none).
// Over 200 lines: one script over one pair of sheets; split, each part would rebuild them.
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// A small row limit, so a "full" sheet takes a few rows (read when constants load).
process.env.MAX_ROWS_PER_SHEET = '6'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const L = await import('../../server/src/lib/enrich-list')
  const { listAnswerCells } = await import('../../server/src/lib/enrich-outcome')
  const { ENRICH_CELL } = await import('../../server/src/lib/enrich-cells')
  const { reusableAnswer } = await import('../../server/src/lib/enrich-reuse-key')
  const { parseListInput } = await import('../../server/src/lib/enrich-list-input')
  const { normalizeTool } = await import('../../server/src/lib/enrich-tool')
  const { readTregMeta } = await import('../../server/src/lib/treg-meta')
  const { planListRun } = await import('../../server/src/services/enrich-list-build')
  const { recallChoices } = await import('../../server/src/lib/enrich-run-recall')
  const { writeEnrichmentResult } = await import('../../server/src/services/enrich-row-write')
  const { addListItems } = await import('../../server/src/services/enrich-list-add')
  const { drainListItems } = await import('../../server/src/services/enrich-list-drain')
  runMigrations()

  // --- The row's cells -----------------------------------------------------------
  const meta = readTregMeta({})
  const listCfg = {
    destSheetId: 'd', itemsPath: '$.result.sources', provider: null, maxItems: 10, fields: null, copy: [], dedupe: null,
  }
  const mapping = [{ columnName: 'Answer', jsonPath: '$.result.text' }]
  const answer = (sources: unknown[], text = 'Acme is good') => ({ result: { text, sources } })
  const cells = (body: unknown, m = mapping, routed = false) =>
    listAnswerCells({ routed, body, meta, providerNames: {}, list: listCfg, mapping: m, sameAsRow: null })
  const both = cells(answer([{ url: 'https://a.example' }]))
  check('results and outputs: the outputs fill, the results go to the journal',
    both.items.length === 1 && both.cells.fill === 'all' && both.cells.statusCell === '' && both.answered)
  const noRows = cells(answer([]))
  check('outputs but no results: "No rows to add", outputs filled, answered',
    noRows.items.length === 0 && noRows.cells.statusCell === ENRICH_CELL.noRows && noRows.cells.fill === 'all'
    && noRows.answered)
  const nothing = cells(answer([], ''))
  check('neither: Not found, nothing filled (still answered)',
    nothing.cells.statusCell === ENRICH_CELL.notFound && nothing.cells.fill === 'none' && nothing.answered)
  const unmapped = cells(answer([]), [])
  check('no outputs picked: an empty list is Not found, as before',
    unmapped.cells.statusCell === ENRICH_CELL.notFound && unmapped.cells.fill === 'none')
  const miss = (outcome: string) => cells({ output: { answer: null },
    _treg: { outcome: 'miss', tried: [{ provider: 'cloro', outcome, status: 200 }] } }, mapping, true)
  check('a waterfall miss its provider answered: Not found, answered (replaces earlier rows)',
    miss('miss').cells.statusCell === ENRICH_CELL.notFound && miss('miss').answered && miss('not_found').answered)
  check('a miss from a provider error or skip, or with no tries listed: not answered (earlier rows stay)',
    !miss('error').answered && !miss('skipped').answered
    && !cells({ output: null, _treg: { outcome: 'miss' } }, mapping, true).answered)
  const capped = listAnswerCells({ routed: true, body: { _treg: { outcome: 'miss' } },
    meta: { ...meta, routeCapped: true }, providerNames: {}, list: listCfg, mapping, sameAsRow: null })
  check('over budget: not answered (earlier rows stay)', capped.cells.statusCell === ENRICH_CELL.budget
    && !capped.answered)
  check('a single tool\'s answer without the list (a soft failure): not answered',
    !cells({ success: false, error: 'busy' }).answered)
  const hitBody = { output: { sources: [{ u: 1 }] }, _treg: { outcome: 'hit', served_by: 'cloro.x' } }
  const foundBy = listAnswerCells({
    routed: true, body: hitBody, meta, providerNames: { cloro: 'Cloro' },
    list: { ...listCfg, itemsPath: '$.output.sources' },
    mapping: [{ columnName: 'Found by', jsonPath: '$._cubex.found_by' }], sameAsRow: null,
  })
  check('a waterfall with results fills Found by even with no other output',
    foundBy.cells.fill === 'all' && (foundBy.cells.answer as any)._cubex.found_by === 'Cloro')

  const list = { list: true, routed: false, mapped: true }
  check('reusable: a list answer with only its outputs filled',
    reusableAnswer({ cells: noRows.cells, stored: { a: 1 }, items: [] }, list))
  check('not reusable: a list answer with nothing',
    !reusableAnswer({ cells: nothing.cells, stored: { a: 1 }, items: [] }, list))

  // --- Fixed values and a results path ---------------------------------------------
  check('a fixed value copies as itself', JSON.stringify(L.copyValues({
    copy: [{ id: 'c1', from: '', to: 'Engine', value: 'ChatGPT' }, { id: 'c2', from: 'Q', to: 'Q' }],
  } as never, { Q: 'Best CRM?' })) === JSON.stringify({ c1: 'ChatGPT', c2: 'Best CRM?' }))
  const fixed = parseListInput({ dest: { newSheetName: 'Sites' },
    copy: [{ to: 'Engine', value: `Chat${String.fromCharCode(0x202e)}GPT` }, { from: 'Question' }],
    itemsPath: '$.result.sources' })
  check('list input: a fixed value (direction characters out) and a results path',
    typeof fixed === 'object' && fixed !== null && fixed.copy[0].value === 'ChatGPT' && fixed.copy[0].from === ''
    && fixed.copy[1].from === 'Question' && fixed.itemsPath === '$.result.sources')
  const bad = (v: unknown) => typeof parseListInput(v) === 'string'
  check('list input refuses a fixed value without a name, with a from, too long, a run\'s words, a bad path',
    bad({ dest: { newSheetName: 'S' }, copy: [{ value: 'x' }] })
    && bad({ dest: { newSheetName: 'S' }, copy: [{ to: 'B', value: '⏳ Processing...' }] })
    && bad({ dest: { newSheetName: 'S' }, copy: [{ from: 'A', to: 'B', value: 'x' }] })
    && bad({ dest: { newSheetName: 'S' }, copy: [{ to: 'B', value: 'x'.repeat(201) }] })
    && bad({ dest: { newSheetName: 'S' }, itemsPath: '$..x' }))

  // A single tool whose example shows its sources empty.
  const tool = normalizeTool({
    endpoint: { id: 'cloro.ai-search.gemini.scrape', name: 'Gemini', provider: 'cloro', kind: 'data', method: 'POST',
      cost: { type: 'per_call', usd: 0.0024 }, input: { bodyType: 'json', body: { prompt: { type: 'string' } } } },
    example_response: { success: true, result: { text: 'An answer', sources: [], pills: [], tags: ['a'] } },
  })!
  check('the example\'s lists that could hold results are kept, empty ones too; none is the listed results',
    tool.list === null && tool.arrays.includes('$.result.sources') && tool.arrays.includes('$.result.pills'))
  const nested = normalizeTool({ endpoint: { id: 'x.y', name: 'Y', provider: 'x', kind: 'data', method: 'GET',
    cost: { usd: 0.001 } }, example_response: { blocks: [{ refs: [] }] } })!
  check('but not a list of plain values, nor one inside another list\'s item',
    !tool.arrays.includes('$.result.tags') && nested.arrays.join() === '$.blocks')
  const listIn = (itemsPath?: string) => ({ dest: { newSheetName: 'S' }, provider: null, maxItems: 10, fields: null,
    copy: [], dedupePath: null, ...(itemsPath ? { itemsPath } : {}) })
  const planned = planListRun(tool, listIn('$.result.sources'), ['prompt'])
  check('a run may name a list the example shows empty', 'itemsPath' in planned
    && planned.itemsPath === '$.result.sources')
  check('but not one the example lacks, nor none at all',
    'fail' in planListRun(tool, listIn('$.result.nope'), ['prompt']) && 'fail' in planListRun(tool, listIn(), []))
  const listed = { ...tool, list: { field: 'blocks', path: '$.result.blocks' } }
  const plain = planListRun(listed, listIn(), ['prompt'])
  check('no named list: the catalog\'s; a named one the example lacks is refused, never swapped',
    'itemsPath' in plain && plain.itemsPath === '$.result.blocks'
    && 'fail' in planListRun(listed, listIn('$.result.gone'), ['prompt']))

  const recalled = (extra: Record<string, unknown>) => recallChoices({
    requestConfig: { method: 'POST', url: 'x', headers: {}, body: '{}' }, responseMapping: [],
    enrichment: { v: 1, toolId: 't', kind: 'single', route: { prefer: [], exclude: [], stopAtFirst: false },
      rows: { mode: 'all', status: null, test: false, where: [] }, list: { ...listCfg, destSheetId: 'd', ...extra } },
  } as never, 'Gemini').list
  check('a rerun keeps a named results path, and only a named one',
    recalled({ itemsNamed: true })?.itemsPath === '$.result.sources' && recalled({})?.itemsPath === undefined)

  // --- Writes ----------------------------------------------------------------------
  const uid = uuid(), tableId = uuid(), src = uuid(), dest = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'Audit')
  const sheet = db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  sheet.run(src, tableId, uid, 'Questions', JSON.stringify(['Question', 'Gemini', 'Answer']))
  sheet.run(dest, tableId, uid, 'Sites', JSON.stringify(['Engine', 'URL']))
  const rowId = uuid()
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(rowId, src, uid, 0, JSON.stringify({ Question: 'Best CRM?', Gemini: '⏳ Processing...', Answer: '' }))
  const cfg = { ...listCfg, destSheetId: dest, fields: [{ path: '$.url', columnName: 'URL' }],
    copy: [{ id: 'c1', from: '', to: 'Engine', value: 'Gemini' }] }
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
    dest_sheet_id) VALUES (?, ?, ?, ?, 'running', 1, 'Gemini', ?)`)
    .run(runId, src, uid, JSON.stringify({ requestConfig: {}, responseMapping: mapping,
      enrichment: { v: 1, list: cfg } }), dest)
  const run = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(runId) as never
  const row = () => JSON.parse((db.prepare('SELECT data FROM rows WHERE id = ?').get(rowId) as { data: string }).data)
  const destRows = () => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
    .all(dest) as string[]).map(d => JSON.parse(d))
  const pending = () => db.prepare(`SELECT id, items_json FROM enrichment_list_items WHERE run_id = ?
    AND status = 'pending'`).all(runId) as Array<{ id: string; items_json: string }>
  const write = (r: ReturnType<typeof cells>) => writeEnrichmentResult({
    run, generation: 0, rowIndex: 0, cells: r.cells, stored: r.cells.answer, mapping, costMicro: 2400,
    request: { toolId: 'cloro.ai-search.gemini.scrape' },
    list: { items: r.items, copy: L.copyValues(cfg as never, row()), rowId },
  })

  const first = cells(answer([{ url: 'https://a.example' }, { url: 'https://b.example' }]))
  check('a row with results and outputs writes both', write(first) && row().Answer === 'Acme is good'
    && row().Gemini === '➕ Adding 2 rows…' && pending().length === 1)
  addListItems(pending()[0].id)
  check('the drain adds its rows with the fixed value', destRows().length === 2
    && destRows().every(r => r.Engine === 'Gemini') && destRows()[1].URL === 'https://b.example'
    && row().Gemini === '✅ 2 rows added')

  const other = uuid()
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(other, src, uid, 1, JSON.stringify({ Question: 'Cheapest CRM?' }))
  const skipped = writeEnrichmentResult({
    run, generation: 0, rowIndex: 1, cells: cells(answer([])).cells, stored: {}, mapping, costMicro: 2400,
    request: {}, list: { items: [], copy: {}, rowId: other },
  })
  check('no results and no rows added before: nothing journaled, the row says No rows to add', skipped
    && pending().length === 0 && JSON.parse((db.prepare('SELECT data FROM rows WHERE id = ?')
      .get(other) as { data: string }).data).Gemini === ENRICH_CELL.noRows)

  // A test whose fields aren't picked: its empty answers remove nothing (its results wait too).
  db.prepare("UPDATE http_runs SET config = json_set(config, '$.enrichment.list.fields', NULL) WHERE id = ?")
    .run(runId)
  check('a test without fields journals no removal', write(cells(answer([]))) && pending().length === 0
    && row().Gemini === ENRICH_CELL.noRows && destRows().length === 2)
  db.prepare("UPDATE http_runs SET config = json_set(config, '$.enrichment.list.fields', json(?)) WHERE id = ?")
    .run(JSON.stringify(cfg.fields), runId)

  check('a rerun with no results journals the replacement', write(cells(answer([]))) && pending().length === 1
    && row().Gemini === L.listCell.replacing && JSON.parse(pending()[0].items_json).done === ENRICH_CELL.noRows)
  const out = addListItems(pending()[0].id)
  check('the drain removes the rows it added before and ends with the run\'s words',
    'added' in out && out.added === 0 && destRows().length === 0 && row().Gemini === ENRICH_CELL.noRows
    && row().Answer === 'Acme is good')

  // Results still on their way (no rows added yet): an empty answer queues behind them and replaces them too.
  const third = uuid()
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(third, src, uid, 2, JSON.stringify({ Question: 'CRM for two?' }))
  const at = (id: string, index: number, r: ReturnType<typeof cells>) => writeEnrichmentResult({
    run, generation: 0, rowIndex: index, cells: r.cells, stored: {}, mapping, costMicro: 0, request: {},
    list: { items: r.items, copy: {}, rowId: id },
  })
  at(third, 2, cells(answer([{ url: 'https://c.example' }])))
  at(third, 2, cells(answer([])))
  check('an empty answer behind results on their way is journaled', pending().length === 2)
  await drainListItems()
  check('in order: the results are added, then removed', pending().length === 0 && destRows().length === 0)

  // A full sheet: a removal behind results waiting for room goes on (it makes room).
  const fill = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  at(other, 1, cells(answer([{ url: 'https://d.example' }, { url: 'https://e.example' }])))
  await drainListItems()
  for (let i = 0; i < 4; i++) fill.run(uuid(), dest, uid, 100 + i, '{}')
  at(third, 2, cells(answer([{ url: 'https://f.example' }])))
  at(other, 1, cells(answer([])))
  await drainListItems()
  const reasons = db.prepare(`SELECT source_row_id AS r, wait_reason AS w FROM enrichment_list_items
    WHERE run_id = ? AND status = 'pending'`).all(runId) as Array<{ r: string; w: string | null }>
  check('the removal behind a full sheet went on; the results wait for room',
    reasons.length === 1 && reasons[0].r === third && reasons[0].w === 'room'
    && !destRows().some(r => r.URL === 'https://d.example'))

  if (failures) { console.error(`\n${failures} failed`); process.exit(1) }
  console.log('\nall list output checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })
