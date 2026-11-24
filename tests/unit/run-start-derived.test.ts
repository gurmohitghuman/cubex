// Over 200 lines: one fixture testing run-start derived spans across run kinds, rules, filters and cancels.
// Starting a run tells clean, formula and lookup columns reading its columns by span (lib/derived-spans.ts),
// quiet, for every taken row whose pre-seed cell did not already read as empty. Readers wait while seeding
// (placeholder_work = 'seeding'), then follow ⏳ as empty as soon as seeding finishes while the run is going, so
// formulas never keep stale old answers next to ⏳. No paid auto-run is ever triggered. Covers AI/HTTP
// seedThenEnqueue, rule seeding (pass + kept-out rows), enrichment seedEnrichmentThenEnqueue, auto-run
// startAutorunRun, preview skip rows, empty/marker cell filtering, loud-write priority over quiet spans,
// AI writeFailure + cancel, and resetOrphanedRuns dropping leftover seed spans.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'

let enqueueErr: Error | null = null
const queued: unknown[][] = []
const { Sidequest } = createRequire(path.resolve('server/src/queue.ts'))('sidequest')
Sidequest.build = () => ({
  enqueue: async (...args: unknown[]) => {
    if (enqueueErr) throw enqueueErr
    queued.push(args)
    return {}
  },
})

import seedRunMod from '../../server/src/services/run-seed'
import enrichSeedMod from '../../server/src/services/enrich-seed-run'
import autorunStartMod from '../../server/src/services/autorun-start'
import busyMod from '../../server/src/lib/sheet-busy'
import cellsMod from '../../server/src/lib/placeholder-cells'
import ruleSeedMod from '../../server/src/lib/placeholder-rule-seed'
import markersMod from '../../server/src/lib/run-markers'
import writeMod from '../../server/src/lib/run-cells-write'
import aiWriteMod from '../../server/src/services/ai-row-writers'
import markMod from '../../server/src/lib/autorun-mark'
import kickMod from '../../server/src/lib/autorun-kick'
import spansMod from '../../server/src/lib/derived-spans'
import lifecycleMod from '../../server/src/services/run-lifecycle'
import orphanMod from '../../server/src/lib/orphan-runs'
import formulaMod from '../../server/src/services/formula-column'
import cleanMod from '../../server/src/services/clean-column'
import lookupMod from '../../server/src/services/lookup-column'
import followMod from '../../server/src/services/derived-follow'
import entryMod from '../../server/src/services/autorun-entry'
import condMod from '../../server/src/lib/run-condition'
import enrichToolMod from '../../server/src/lib/enrich-tool'
import enrichCfgMod from '../../server/src/lib/enrich-run-config'
import walMod from '../../server/src/lib/wal-checkpointer'
import type { EnrichRunConfig } from '../../server/src/lib/enrich-run-config'
import type { HTTPAPIConfig } from '../../server/src/lib/http-request-template'
const { seedThenEnqueue } = seedRunMod as typeof import('../../server/src/services/run-seed')
const { seedEnrichmentThenEnqueue } = enrichSeedMod as typeof import('../../server/src/services/enrich-seed-run')
const { startAutorunRun } = autorunStartMod as typeof import('../../server/src/services/autorun-start')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { seedProcessingPlaceholders, PLACEHOLDER } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { seedPlaceholdersByRule } = ruleSeedMod as typeof import('../../server/src/lib/placeholder-rule-seed')
const { CONDITION_NOT_MET, FAILED_MARK, LIST_MARK, SKIPPED_MARK } =
  markersMod as typeof import('../../server/src/lib/run-markers')
const { writeRunCells } = writeMod as typeof import('../../server/src/lib/run-cells-write')
const { writeFailure } = aiWriteMod as typeof import('../../server/src/services/ai-row-writers')
const { markAutorunInputs } = markMod as typeof import('../../server/src/lib/autorun-mark')
const { onFollowQueued } = kickMod as typeof import('../../server/src/lib/autorun-kick')
const { nextSpan } = spansMod as typeof import('../../server/src/lib/derived-spans')
const { cancelRun } = lifecycleMod as typeof import('../../server/src/services/run-lifecycle')
const { resetOrphanedRuns } = orphanMod as typeof import('../../server/src/lib/orphan-runs')
const { startFormulaColumn } = formulaMod as typeof import('../../server/src/services/formula-column')
const { startCleanColumn } = cleanMod as typeof import('../../server/src/services/clean-column')
const { startLookupColumn } = lookupMod as typeof import('../../server/src/services/lookup-column')
const { derivedFollowTick, kickDerivedFollow } = followMod as typeof import('../../server/src/services/derived-follow')
const { entryFor, loadEntry } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { checkRule } = condMod as typeof import('../../server/src/lib/run-condition')
const { normalizeTool } = enrichToolMod as typeof import('../../server/src/lib/enrich-tool')
const { requestToolOf } = enrichCfgMod as typeof import('../../server/src/lib/enrich-run-config')
const { closeWalCheckpointer } = walMod as typeof import('../../server/src/lib/wal-checkpointer')

const { db, uid, idle, sheet, cells } = undoKit('run-start-derived')
console.error = () => {}

const FIND_FIXTURE = 'tests/mock-treg/fixtures/catalog/endpoints/treg.people.email.find.json'
const FIND_TOOL = normalizeTool(JSON.parse(fs.readFileSync(FIND_FIXTURE, 'utf8')))!

const until = async (what: string, cond: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !cond();) {
    if (Date.now() > end) throw new Error(`Timed out waiting until ${what}`)
    await new Promise(r => setTimeout(r, 15))
  }
}
const entry = (sid: string, col: string) => entryFor(sid, uid, col)!.id
const spans = (sid: string) => db.prepare('SELECT COUNT(*) FROM derived_spans WHERE sheet_id = ?')
  .pluck().get(sid) as number
const marks = (sid: string) => db.prepare(`SELECT COUNT(*) FROM derived_span_marks
  WHERE autorun_id IN (SELECT id FROM autorun_columns WHERE sheet_id = ?)`).pluck().get(sid) as number
const queuedIndexes = (sid: string, entryId: string) => db.prepare(`SELECT r.row_index FROM autorun_pending p
  JOIN rows r ON r.id = p.row_id WHERE p.autorun_id = ? ORDER BY r.row_index`).pluck().all(entryId) as number[]
const toldIndexes = (sid: string, col: string) => db.prepare(`SELECT r.row_index FROM derived_span_marks m
  JOIN derived_spans s ON s.id = m.span_id, json_each(s.rowids) j JOIN rows r ON r.rowid = j.value
  WHERE m.autorun_id = ? ORDER BY r.row_index`).pluck().all(entry(sid, col)) as number[]
const tick = (sid: string, col: string) => derivedFollowTick(loadEntry(entry(sid, col))!)
const addPaid = (
  sid: string, status: string, kind: 'http' | 'enrichment', input: string, watermark: number,
) => {
  const id = uuid()
  db.prepare(`INSERT INTO autorun_columns
    (id, user_id, sheet_id, status_column, kind, input_columns, watermark_row_index)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, uid, sid, status, kind, JSON.stringify([input]), watermark)
  return id
}

function insertRun(
  kind: 'ai' | 'http', sid: string, columns: string[], status = 'pending', work: string | null = 'seeding',
) {
  const id = uuid()
  if (kind === 'ai') {
    db.prepare(`INSERT INTO ai_runs
      (id, sheet_id, user_id, column_name, prompt, status, worker_generation, placeholder_work)
      VALUES (?, ?, ?, ?, 'p', ?, 1, ?)`).run(id, sid, uid, columns[0], status, work)
  } else {
    db.prepare(`INSERT INTO http_runs
      (id, sheet_id, user_id, config, status, master_column_name, worker_generation, placeholder_work)
      VALUES (?, ?, ?, '{}', ?, ?, 1, ?)`).run(id, sid, uid, status, columns[0], work)
    for (const c of columns.slice(1)) {
      db.prepare(`INSERT INTO http_column_associations
        (id, sheet_id, user_id, master_column_name, extracted_column_name, run_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(uuid(), sid, uid, columns[0], c, id)
    }
  }
  return id
}

async function setupDerivedScene() {
  const other = sheet([{ Key: 'Old A', Label: 'Matched A' }, { Key: 'Old B', Label: 'Matched B' },
    { Key: 'New A', Label: 'Matched New A' }], ['Key', 'Label'])
  const sid = sheet([
    { Name: 'a', Answer: 'Old A' },
    { Name: 'b', Answer: 'Old B' },
    { Name: 'c', Answer: '' },
  ], ['Name', 'Answer', 'Status', 'Hook', 'Enriched', 'Enriched 2'])
  const f = '{{Answer}} ? "has " + {{Answer}} : "empty"'
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'F', formula: f }))
  await idle(sid)
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'F2', formula: '{{F}}.toUpperCase()' }))
  await idle(sid)
  assert.ok('ok' in await startCleanColumn(uid, sid, { source: 'Answer', cleaner: 'lowercase', column: 'Low' }))
  await idle(sid)
  assert.ok('ok' in await startLookupColumn(uid, sid, {
    column: 'Look', sourceColumn: 'Answer', otherSheetId: other, matchColumn: 'Key', returns: 'value',
    returnColumn: 'Label',
  }))
  await idle(sid)
  await tick(sid, 'F2')
  assert.deepEqual(cells(sid, 'F'), ['has Old A', 'has Old B', 'empty'])
  assert.deepEqual(cells(sid, 'F2'), ['HAS OLD A', 'HAS OLD B', 'EMPTY'])
  assert.deepEqual(cells(sid, 'Low'), ['old a', 'old b', ''])
  assert.deepEqual(cells(sid, 'Look'), ['Matched A', 'Matched B', ''])
  const paid = [
    addPaid(sid, 'Hook', 'http', 'Answer', 2),
    addPaid(sid, 'Enriched', 'enrichment', 'F', 2),
    addPaid(sid, 'Enriched 2', 'enrichment', 'F2', 2),
  ]
  return { sid, paid }
}

function makeEnrichConfig(): EnrichRunConfig {
  return {
    requestConfig: {
      method: 'POST', url: '',
      body: JSON.stringify({ full_name: '{{Name}}', domain: '{{Domain}}' }),
    },
    responseMapping: [{ jsonPath: '$.email', columnName: 'Email' }],
    previewSize: 5,
    enrichment: { toolSnapshot: requestToolOf(FIND_TOOL), cleanDomains: false },
  } as unknown as EnrichRunConfig
}

async function setupEnrichScene() {
  const cols = ['Name', 'Domain', 'Status', 'Email', 'Paid']
  const sid = sheet([
    { Name: 'Ada L', Domain: 'a.com', Status: '✅ Found', Email: 'A@A.com' },
    { Name: 'Bo K', Domain: 'b.com', Status: '✅ Found', Email: 'B@B.com' },
  ], cols)
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'F', formula: '{{Email}} || "none"' }))
  await idle(sid)
  assert.ok('ok' in await startCleanColumn(uid, sid, { source: 'Email', cleaner: 'lowercase', column: 'Low' }))
  await idle(sid)
  const paid = addPaid(sid, 'Paid', 'enrichment', 'F', 1)
  return { sid, paid, cols: [...cols, 'F', 'Low'] }
}

let failures = 0
async function run(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log('ok  ', name)
  } catch (e) {
    failures++
    console.log('FAIL', name, '\n ', (e as Error).stack)
  }
}

for (const kind of ['ai', 'http'] as const) {
  await run(`${kind} run start kicks clean, formula, chained formula and lookup while going, quiet (0 paid runs)`,
    async () => {
      const { sid, paid } = await setupDerivedScene()
      const cols = kind === 'ai' ? ['Answer'] : ['Status', 'Answer']
      const runId = insertRun(kind, sid, cols, 'pending', 'seeding')
      onFollowQueued(kickDerivedFollow)
      try {
        await withSheetBusy(sid, 'starting a run', async () => {
          seedThenEnqueue({
            kind, runId, sheetId: sid, userId: uid, columns: cols, targets: null, lastRow: 2,
            enqueue: async () => {
              const t = kind === 'ai' ? 'ai_runs' : 'http_runs'
              db.prepare(`UPDATE ${t} SET status = 'running' WHERE id = ?`).run(runId)
            },
          })
        })
        await until('all derived readers clear while run is going', () =>
          JSON.stringify(cells(sid, 'F')) === JSON.stringify(['empty', 'empty', 'empty'])
          && JSON.stringify(cells(sid, 'F2')) === JSON.stringify(['EMPTY', 'EMPTY', 'EMPTY'])
          && JSON.stringify(cells(sid, 'Low')) === JSON.stringify(['', '', ''])
          && JSON.stringify(cells(sid, 'Look')) === JSON.stringify(['', '', '']), 10_000)
        // Cells still hold ⏳ while derived columns already updated.
        assert.deepEqual(cells(sid, 'Answer'), [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER])
        assert.deepEqual([spans(sid), marks(sid)], [0, 0], 'spans finished')
        assert.deepEqual(paid.map(p => queuedIndexes(sid, p)), [[], [], []], 'zero paid auto-runs queued')

        // Worker answers row 0: derived columns update loudly and paid auto-runs hear of row 0.
        db.transaction(() => {
          const w: Array<[string, string]> = kind === 'ai'
            ? [['Answer', 'New A']]
            : [['Status', '✅'], ['Answer', 'New A']]
          writeRunCells({ kind, id: runId }, sid, uid, 0, w)
          markAutorunInputs(sid, uid, w.map(([c]) => c), { indexes: [0] })
        }).immediate()
        await until('derived readers follow row 0 answer', () =>
          cells(sid, 'F')[0] === 'has New A' && cells(sid, 'F2')[0] === 'HAS NEW A'
          && cells(sid, 'Low')[0] === 'new a' && cells(sid, 'Look')[0] === 'Matched New A', 10_000)
        assert.deepEqual(paid.map(p => queuedIndexes(sid, p)), [[0], [0], [0]],
          'paid auto-runs hear only of row 0')

        // Cancel remaining rows: row 1 gets Old B back and derived columns restore row 1 quietly.
        db.prepare('DELETE FROM autorun_pending').run()
        assert.deepEqual(await cancelRun(kind, runId, uid), { ok: true })
        await until('derived readers restore row 1 after cancel', () =>
          cells(sid, 'F')[1] === 'has Old B' && cells(sid, 'F2')[1] === 'HAS OLD B'
          && cells(sid, 'Low')[1] === 'old b' && cells(sid, 'Look')[1] === 'Matched B', 10_000)
        assert.deepEqual(cells(sid, 'Answer'), ['New A', 'Old B', ''])
        assert.deepEqual(paid.map(p => queuedIndexes(sid, p)), [[], [], []], 'cancel triggers no paid auto-run')
      } finally { onFollowQueued(() => {}) }
    })
}

await run('only non-empty non-marker cells are told; a first run on an empty column creates 0 spans', async () => {
  const vals: unknown[] = [
    undefined, '', null, PLACEHOLDER, `  ${PLACEHOLDER}`, `${FAILED_MARK} Error`,
    `\t${SKIPPED_MARK} Not found`, `\u00a0${LIST_MARK} Adding 2 rows`,
    '  ', 0, false, { a: 1 }, 'Real',
  ]
  const sid = sheet(vals.map((v, i) => (v === undefined ? { Name: `n${i}` } : { Name: `n${i}`, Answer: v })),
    ['Name', 'Answer'])
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'F', formula: '{{Answer}} ? "y" : "n"' }))
  await idle(sid)
  const runId = insertRun('ai', sid, ['Answer'], 'pending', 'seeding')
  await seedProcessingPlaceholders({
    run: { kind: 'ai', id: runId }, sheetId: sid, userId: uid, columns: ['Answer'],
    targets: null, lastRow: vals.length - 1, live: () => true,
  })
  // While placeholder_work = 'seeding', nextSpan waits.
  assert.equal(nextSpan(entry(sid, 'F')), null, 'readers wait while seeding')
  assert.deepEqual(toldIndexes(sid, 'F'), [8, 9, 10, 11, 12], 'only whitespace, 0, false, object and text told')
  assert.deepEqual(queuedIndexes(sid, entry(sid, 'F')), [], 'told by span, not autorun_pending')

  // Brand-new empty column: 0 spans created.
  const emptySid = sheet([{ Name: 'a' }, { Name: 'b', Answer: '' }, { Name: 'c', Answer: `${FAILED_MARK} old` }],
    ['Name', 'Answer'])
  assert.ok('ok' in await startFormulaColumn(uid, emptySid, { column: 'F', formula: '{{Answer}} + "!"' }))
  await idle(emptySid)
  const run2 = insertRun('ai', emptySid, ['Answer'], 'pending', 'seeding')
  await seedProcessingPlaceholders({
    run: { kind: 'ai', id: run2 }, sheetId: emptySid, userId: uid, columns: ['Answer'],
    targets: null, lastRow: 2, live: () => true,
  })
  assert.deepEqual([spans(emptySid), marks(emptySid)], [0, 0], 'no spans for already-empty cells')
})

await run('preview-skipped rows are not told', async () => {
  const sid = sheet([{ Answer: 'Old 0' }, { Answer: 'Old 1' }, { Answer: 'Old 2' }], ['Answer'])
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'F', formula: '{{Answer}} + "!"' }))
  await idle(sid)
  const runId = insertRun('ai', sid, ['Answer'], 'running', null)
  await seedProcessingPlaceholders({
    run: { kind: 'ai', id: runId }, sheetId: sid, userId: uid, columns: ['Answer'],
    targets: null, lastRow: 2, skip: new Set([0]), live: () => true,
  })
  assert.deepEqual(toldIndexes(sid, 'F'), [1, 2], 'skipped row 0 excluded')
  await tick(sid, 'F')
  assert.deepEqual(cells(sid, 'F'), ['Old 0!', '!', '!'])
})

await run('rule seeding: pass rows get run-linked spans, kept-out rows with emptied outputs survive cancel',
  async () => {
    const sid = sheet([
      { Flag: 'yes', Status: '✅', Out: 'Old 0' },
      { Flag: 'no', Status: `${FAILED_MARK} old`, Out: 'Old 1' },
      { Flag: 'no', Status: '✅', Out: 'Old 2' }, // paid result kept; not overwritten
    ], ['Flag', 'Status', 'Out'])
    const f = '{{Out}} ? "has " + {{Out}} : "empty"'
    assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'F', formula: f }))
    await idle(sid)
    assert.deepEqual(cells(sid, 'F'), ['has Old 0', 'has Old 1', 'has Old 2'])
    const checked = checkRule('{{Flag}} is "yes"', ['Flag', 'Status', 'Out'])
    const runId = insertRun('http', sid, ['Status', 'Out'], 'pending', 'seeding')
    const seeded = await seedPlaceholdersByRule({
      run: { kind: 'http', id: runId }, sheetId: sid, userId: uid, columns: ['Status', 'Out'],
      rule: { tree: checked.tree, columns: checked.columns, markColumn: 'Status' },
      targets: null, lastRow: 2, live: () => true,
    })
    assert.deepEqual(seeded, { notMet: 2 })
    assert.deepEqual(cells(sid, 'Status'), [PLACEHOLDER, CONDITION_NOT_MET, '✅'])
    assert.deepEqual(cells(sid, 'Out'), [PLACEHOLDER, '', 'Old 2'])
    // Cancel before F runs: row 0's run-linked seed span drops and clear restores Old 0; row 1's unlinked kept-out
    // span survives so F still clears row 1 to "empty".
    assert.deepEqual(await cancelRun('http', runId, uid), { ok: true })
    await until('cancel cleared', () =>
      db.prepare('SELECT placeholder_work FROM http_runs WHERE id = ?').pluck().get(runId) === null)
    await tick(sid, 'F'); await tick(sid, 'F')
    assert.deepEqual(cells(sid, 'Out'), ['Old 0', '', 'Old 2'])
    assert.deepEqual(cells(sid, 'F'), ['has Old 0', 'empty', 'has Old 2'])
  })

await run('enrichment seeding (seedEnrichmentThenEnqueue) clears readers while pending and restores on cancel',
  async () => {
    const { sid, paid, cols } = await setupEnrichScene()
    const runId = insertRun('http', sid, ['Status', 'Email'], 'pending', 'seeding')
    const config = makeEnrichConfig()
    db.prepare('UPDATE http_runs SET config = ? WHERE id = ?').run(JSON.stringify(config), runId)
    enqueueErr = null
    const before = queued.length
    onFollowQueued(kickDerivedFollow)
    try {
      await withSheetBusy(sid, 'starting a run', async () => {
        seedEnrichmentThenEnqueue({
          runId, sheetId: sid, userId: uid, columns: ['Status', 'Email'],
          plan: { statusColumn: null, status: 'any', where: [], rule: null, config, columns: cols },
          rowFilter: { clause: '', params: [] }, targets: null, lastRow: 1, test: null,
        })
      })
      await until('readers cleared while enrichment is pending', () =>
        db.prepare('SELECT placeholder_work FROM http_runs WHERE id = ?').pluck().get(runId) === null
        && JSON.stringify(cells(sid, 'F')) === JSON.stringify(['none', 'none'])
        && JSON.stringify(cells(sid, 'Low')) === JSON.stringify(['', '']), 10_000)
      assert.equal(queued.length, before + 1, 'run enqueued once')
      assert.equal(db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(runId), 'pending')
      assert.deepEqual(cells(sid, 'Email'), [PLACEHOLDER, PLACEHOLDER])
      assert.deepEqual([spans(sid), marks(sid)], [0, 0])
      assert.deepEqual(queuedIndexes(sid, paid), [], 'zero paid auto-runs queued')

      assert.deepEqual(await cancelRun('http', runId, uid), { ok: true })
      await until('readers restored after enrichment cancel', () =>
        db.prepare('SELECT placeholder_work FROM http_runs WHERE id = ?').pluck().get(runId) === null
        && JSON.stringify(cells(sid, 'F')) === JSON.stringify(['A@A.com', 'B@B.com'])
        && JSON.stringify(cells(sid, 'Low')) === JSON.stringify(['a@a.com', 'b@b.com']), 10_000)
      assert.deepEqual(cells(sid, 'Email'), ['A@A.com', 'B@B.com'])
      assert.deepEqual(queuedIndexes(sid, paid), [], 'zero paid auto-runs queued on cancel')
    } finally { onFollowQueued(() => {}); enqueueErr = null }
  })

await run('enrichment seeding enqueue failure drops seed spans, restores cells and readers, quiet',
  async () => {
    const { sid, paid, cols } = await setupEnrichScene()
    const runId = insertRun('http', sid, ['Status', 'Email'], 'pending', 'seeding')
    const config = makeEnrichConfig()
    db.prepare('UPDATE http_runs SET config = ? WHERE id = ?').run(JSON.stringify(config), runId)
    enqueueErr = new Error('the queue is down')
    onFollowQueued(kickDerivedFollow)
    try {
      await withSheetBusy(sid, 'starting a run', async () => {
        seedEnrichmentThenEnqueue({
          runId, sheetId: sid, userId: uid, columns: ['Status', 'Email'],
          plan: { statusColumn: null, status: 'any', where: [], rule: null, config, columns: cols },
          rowFilter: { clause: '', params: [] }, targets: null, lastRow: 1, test: null,
        })
      })
      await until('enrichment failure settled and cleared', () =>
        db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(runId) === 'failed'
        && db.prepare('SELECT placeholder_work FROM http_runs WHERE id = ?').pluck().get(runId) === null
        && spans(sid) === 0 && marks(sid) === 0, 10_000)
      assert.deepEqual(cells(sid, 'Email'), ['A@A.com', 'B@B.com'])
      assert.deepEqual(cells(sid, 'F'), ['A@A.com', 'B@B.com'])
      assert.deepEqual(cells(sid, 'Low'), ['a@a.com', 'b@b.com'])
      assert.deepEqual(queuedIndexes(sid, paid), [], 'zero paid auto-runs queued')
    } finally { onFollowQueued(() => {}); enqueueErr = null }
  })

await run('enrichment seeding with seeded = 0 (all kept out by runIf) completes and kicks unlinked readers',
  async () => {
    const cols = ['Name', 'Domain', 'Flag', 'Status', 'Paid']
    const sid = sheet([
      { Name: 'Ada L', Domain: 'a.com', Flag: 'no', Status: '  ' },
      { Name: 'Bo K', Domain: 'b.com', Flag: 'no', Status: '✅ Kept' },
    ], cols)
    const f = '{{Status}} ? "has:" + {{Status}} : "empty"'
    assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'F', formula: f }))
    await idle(sid)
    assert.deepEqual(cells(sid, 'F'), ['has:  ', 'has:✅ Kept'])
    const paid = addPaid(sid, 'Paid', 'enrichment', 'F', 1)
    const checked = checkRule('{{Flag}} is "yes"', cols)
    const runId = insertRun('http', sid, ['Status'], 'pending', 'seeding')
    const config = makeEnrichConfig()
    db.prepare('UPDATE http_runs SET config = ? WHERE id = ?').run(JSON.stringify(config), runId)
    enqueueErr = null
    const before = queued.length
    onFollowQueued(kickDerivedFollow)
    try {
      await withSheetBusy(sid, 'starting a run', async () => {
        seedEnrichmentThenEnqueue({
          runId, sheetId: sid, userId: uid, columns: ['Status'],
          plan: {
            statusColumn: null, status: 'any', where: [], rule: checked.tree, config, columns: [...cols, 'F'],
          },
          rowFilter: { clause: '', params: [] }, targets: null, lastRow: 1, test: null,
        })
      })
      await until('kept-out run completes and reader clears row 0', () =>
        db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(runId) === 'completed'
        && db.prepare('SELECT placeholder_work FROM http_runs WHERE id = ?').pluck().get(runId) === null
        && cells(sid, 'F')[0] === 'empty' && spans(sid) === 0, 10_000)
      assert.equal(queued.length, before, 'zero-seeded run does not enqueue')
      assert.deepEqual(cells(sid, 'Status'), [CONDITION_NOT_MET, '✅ Kept'])
      assert.deepEqual(cells(sid, 'F'), ['empty', 'has:✅ Kept'])
      assert.deepEqual(queuedIndexes(sid, paid), [], 'zero paid auto-runs queued')
    } finally { onFollowQueued(() => {}); enqueueErr = null }
  })

await run('startAutorunRun tells derived readers while pending, and drops seed spans if enqueue throws',
  async () => {
    const httpCfg: HTTPAPIConfig = {
      requestConfig: { method: 'POST', url: 'https://x.test/go', headers: {}, body: '{"d":"{{Domain}}"}' },
      responseMapping: [{ jsonPath: '$.answer', columnName: 'Answer' }],
    }
    const cols = ['Domain', 'Status', 'Answer', 'Paid']
    const makeAutorunSheet = () => sheet([
      { Domain: 'a.com', Status: `${FAILED_MARK} old`, Answer: 'Old A' },
      { Domain: 'b.com', Status: '✅', Answer: 'Old B' },
    ], cols)
    const addHttpAuto = (sid: string) => {
      const id = uuid()
      db.prepare(`INSERT INTO autorun_columns
        (id, user_id, sheet_id, status_column, kind, input_columns, watermark_row_index)
        VALUES (?, ?, ?, 'Status', 'http', '["Domain"]', 1)`).run(id, uid, sid)
      return id
    }

    // Success path: startAutorunRun seeds, tells F, kicks F after enqueue, F clears while run stays pending.
    const sid = makeAutorunSheet()
    const row0Id = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND row_index = 0').pluck().get(sid) as string
    const f = '{{Answer}} ? "has " + {{Answer}} : "empty"'
    assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'F', formula: f }))
    await idle(sid)
    assert.deepEqual(cells(sid, 'F'), ['has Old A', 'has Old B'])
    const paid = addPaid(sid, 'Paid', 'enrichment', 'F', 1)
    const autoId = addHttpAuto(sid)
    const plan = {
      kind: 'http' as const, statusColumn: 'Status', config: httpCfg,
      columns: [...cols, 'F'], requestCols: ['Domain'], where: [], rule: null,
    }
    const prep = { config: httpCfg, allowSecrets: 0, outputs: ['Answer'], dest: null }
    enqueueErr = null
    onFollowQueued(kickDerivedFollow)
    try {
      const res = await startAutorunRun(
        loadEntry(autoId)!, plan, { rows: [{ id: row0Id, fromPending: true }], watermark: 1 }, prep,
      )
      assert.ok('started' in res, JSON.stringify(res))
      await until('F clears row 0 while auto-run is pending', () =>
        cells(sid, 'F')[0] === 'empty' && spans(sid) === 0, 10_000)
      assert.deepEqual(cells(sid, 'Answer'), [PLACEHOLDER, 'Old B'])
      assert.deepEqual(cells(sid, 'F'), ['empty', 'has Old B'])
      assert.deepEqual(queuedIndexes(sid, paid), [], 'zero paid auto-runs queued')
    } finally { onFollowQueued(() => {}); enqueueErr = null }

    // Enqueue-failure path: drops seed span before clear writes one clear span, restores cells, keeps F intact.
    const sid2 = makeAutorunSheet()
    const row0Id2 = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND row_index = 0').pluck().get(sid2) as string
    assert.ok('ok' in await startFormulaColumn(uid, sid2, { column: 'F', formula: f }))
    await idle(sid2)
    const paid2 = addPaid(sid2, 'Paid', 'enrichment', 'F', 1)
    const autoId2 = addHttpAuto(sid2)
    enqueueErr = new Error('the queue is down')
    onFollowQueued(() => {})
    try {
      const res2 = await startAutorunRun(
        loadEntry(autoId2)!, plan, { rows: [{ id: row0Id2, fromPending: true }], watermark: 1 }, prep,
      )
      assert.ok('started' in res2, JSON.stringify(res2))
      assert.deepEqual([spans(sid2), marks(sid2)], [1, 1],
        'only the clear span remains; the seed span was dropped')
      assert.deepEqual(cells(sid2, 'Answer'), ['Old A', 'Old B'])
      assert.deepEqual(cells(sid2, 'Status'), [`${FAILED_MARK} old`, '✅'])
      await tick(sid2, 'F')
      assert.deepEqual([spans(sid2), marks(sid2)], [0, 0])
      assert.deepEqual(cells(sid2, 'F'), ['has Old A', 'has Old B'])
      assert.deepEqual(queuedIndexes(sid2, paid2), [], 'zero paid auto-runs queued')
    } finally { enqueueErr = null }
  })

await run('loud worker answer in autorun_pending is never swallowed by a quiet seed span', async () => {
  const { sid, paid } = await setupDerivedScene()
  const runId = insertRun('http', sid, ['Status', 'Answer'], 'running', null)
  await seedProcessingPlaceholders({
    run: { kind: 'http', id: runId }, sheetId: sid, userId: uid, columns: ['Status', 'Answer'],
    targets: null, lastRow: 2, live: () => true,
  })
  // Worker finishes row 0 BEFORE F processes the seed span.
  db.transaction(() => {
    writeRunCells({ kind: 'http', id: runId }, sid, uid, 0, [['Status', '✅'], ['Answer', 'New A']])
    markAutorunInputs(sid, uid, ['Status', 'Answer'], { indexes: [0] })
  }).immediate()
  await tick(sid, 'F'); await tick(sid, 'F2')
  assert.deepEqual(cells(sid, 'F'), ['has New A', 'empty', 'empty'])
  assert.deepEqual(cells(sid, 'F2'), ['HAS NEW A', 'EMPTY', 'EMPTY'])
  assert.deepEqual(paid.map(p => queuedIndexes(sid, p)), [[0], [0], [0]],
    'loud row 0 answer reached Hook, Enriched and Enriched 2; quiet row 1 ⏳ did not')
})

await run('AI writeFailure + immediate cancel still clears F on the failed row, quiet', async () => {
  const { sid, paid } = await setupDerivedScene()
  const runId = insertRun('ai', sid, ['Answer'], 'running', null)
  await seedProcessingPlaceholders({
    run: { kind: 'ai', id: runId }, sheetId: sid, userId: uid, columns: ['Answer'],
    targets: null, lastRow: 1, live: () => true,
  })
  // Row 0 fails before F reads the seed span; then run is cancelled (dropping seed span, restoring row 1).
  writeFailure({
    runId, userId: uid, sheetId: sid, rowIndex: 0, columnName: 'Answer',
    inputValues: '{}', needsDataColumn: false, myGeneration: 1,
  }, 'model refused')
  assert.deepEqual(await cancelRun('ai', runId, uid), { ok: true })
  await until('cancel cleared', () =>
    db.prepare('SELECT placeholder_work FROM ai_runs WHERE id = ?').pluck().get(runId) === null)
  await tick(sid, 'F'); await tick(sid, 'Low'); await tick(sid, 'Look'); await tick(sid, 'F2')
  assert.match(cells(sid, 'Answer')[0], /^❌ Error: model refused/)
  assert.equal(cells(sid, 'Answer')[1], 'Old B')
  assert.deepEqual(cells(sid, 'F'), ['empty', 'has Old B', 'empty'])
  assert.deepEqual(cells(sid, 'Low'), ['', 'old b', ''])
  assert.deepEqual(cells(sid, 'Look'), ['', 'Matched B', ''])
  assert.deepEqual(cells(sid, 'F2'), ['EMPTY', 'HAS OLD B', 'EMPTY'])
  assert.deepEqual(paid.map(p => queuedIndexes(sid, p)), [[], [], []], 'zero paid auto-runs queued')
})

await run('resetOrphanedRuns drops seed spans of runs interrupted while seeding', async () => {
  const sid = sheet([{ Answer: 'Old 0' }, { Answer: 'Old 1' }], ['Answer'])
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'F', formula: '{{Answer}} + "!"' }))
  await idle(sid)
  const runId = insertRun('ai', sid, ['Answer'], 'pending', 'seeding')
  await seedProcessingPlaceholders({
    run: { kind: 'ai', id: runId }, sheetId: sid, userId: uid, columns: ['Answer'],
    targets: null, lastRow: 1, live: () => true,
  })
  assert.equal(spans(sid), 1)
  resetOrphanedRuns()
  assert.equal(db.prepare('SELECT placeholder_work FROM ai_runs WHERE id = ?').pluck().get(runId), 'clearing')
  assert.deepEqual([spans(sid), marks(sid)], [0, 0], 'orphan seed spans dropped before clear')
})

await closeWalCheckpointer()
if (failures > 0) {
  console.error(`${failures} run-start-derived assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('All run-start-derived assertions passed.')
}
