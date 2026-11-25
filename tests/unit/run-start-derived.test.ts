// Over 200 lines: the run starts of AI and HTTP columns, their rule seeding and their stops, on one fixture.
// Starting a run tells clean, formula and lookup columns reading its columns by span (lib/derived-spans.ts),
// quiet, for every taken row whose pre-seed cell did not already read as empty. Readers wait while seeding
// (placeholder_work = 'seeding'), then follow ⏳ as empty as soon as seeding finishes while the run is going, so
// formulas never keep stale old answers next to ⏳. No paid auto-run is ever triggered. Covers AI/HTTP
// seedThenEnqueue, rule seeding (pass + kept-out rows), preview skip rows, empty/marker cell filtering, loud-write
// priority over quiet spans, AI writeFailure + cancel, and resetOrphanedRuns dropping leftover seed spans.
// Enrichment and auto-run starts: run-start-derived-enrich.test.ts.
import assert from 'node:assert/strict'
import {
  entry, finish, insertRun, kit, marks, queuedIndexes, run, setupDerivedScene, spans, tick, toldIndexes, until,
} from './run-start-kit'
import seedRunMod from '../../server/src/services/run-seed'
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
import followMod from '../../server/src/services/derived-follow'
import condMod from '../../server/src/lib/run-condition'
import walMod from '../../server/src/lib/wal-checkpointer'
const { seedThenEnqueue } = seedRunMod as typeof import('../../server/src/services/run-seed')
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
const { kickDerivedFollow } = followMod as typeof import('../../server/src/services/derived-follow')
const { checkRule } = condMod as typeof import('../../server/src/lib/run-condition')
const { closeWalCheckpointer } = walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { db, uid, idle, sheet, cells } = kit

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
finish('run-start-derived')
