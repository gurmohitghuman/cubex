// Over 200 lines: the enrichment and auto-run starts, each with its readers, its cancel and its queue failure.
// Starting an enrichment run (seedEnrichmentThenEnqueue) or an auto-run's run (startAutorunRun) tells clean, formula
// and lookup columns reading its columns by span (lib/derived-spans.ts), quiet: they follow the ⏳ as empty while
// the run waits, come back on a cancel or a queue failure, and no paid auto-run is ever triggered. Rows a rule kept
// out are told unlinked to the run. AI and HTTP run starts: run-start-derived.test.ts.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import {
  addPaid, finish, insertRun, kit, makeEnrichConfig, marks, queue, queuedIndexes, run, setupEnrichScene, spans, tick,
  until,
} from './run-start-kit'
import enrichSeedMod from '../../server/src/services/enrich-seed-run'
import autorunStartMod from '../../server/src/services/autorun-start'
import busyMod from '../../server/src/lib/sheet-busy'
import cellsMod from '../../server/src/lib/placeholder-cells'
import markersMod from '../../server/src/lib/run-markers'
import kickMod from '../../server/src/lib/autorun-kick'
import lifecycleMod from '../../server/src/services/run-lifecycle'
import formulaMod from '../../server/src/services/formula-column'
import followMod from '../../server/src/services/derived-follow'
import entryMod from '../../server/src/services/autorun-entry'
import condMod from '../../server/src/lib/run-condition'
import walMod from '../../server/src/lib/wal-checkpointer'
import type { HTTPAPIConfig } from '../../server/src/lib/http-request-template'
const { seedEnrichmentThenEnqueue } = enrichSeedMod as typeof import('../../server/src/services/enrich-seed-run')
const { startAutorunRun } = autorunStartMod as typeof import('../../server/src/services/autorun-start')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { PLACEHOLDER } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { CONDITION_NOT_MET, FAILED_MARK } = markersMod as typeof import('../../server/src/lib/run-markers')
const { onFollowQueued } = kickMod as typeof import('../../server/src/lib/autorun-kick')
const { cancelRun } = lifecycleMod as typeof import('../../server/src/services/run-lifecycle')
const { startFormulaColumn } = formulaMod as typeof import('../../server/src/services/formula-column')
const { kickDerivedFollow } = followMod as typeof import('../../server/src/services/derived-follow')
const { loadEntry } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { checkRule } = condMod as typeof import('../../server/src/lib/run-condition')
const { closeWalCheckpointer } = walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { db, uid, idle, sheet, cells } = kit

await run('enrichment seeding (seedEnrichmentThenEnqueue) clears readers while pending and restores on cancel',
  async () => {
    const { sid, paid, cols } = await setupEnrichScene()
    const runId = insertRun('http', sid, ['Status', 'Email'], 'pending', 'seeding')
    const config = makeEnrichConfig()
    db.prepare('UPDATE http_runs SET config = ? WHERE id = ?').run(JSON.stringify(config), runId)
    queue.err = null
    const before = queue.calls.length
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
      assert.equal(queue.calls.length, before + 1, 'run enqueued once')
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
    } finally { onFollowQueued(() => {}); queue.err = null }
  })

await run('enrichment seeding enqueue failure drops seed spans, restores cells and readers, quiet',
  async () => {
    const { sid, paid, cols } = await setupEnrichScene()
    const runId = insertRun('http', sid, ['Status', 'Email'], 'pending', 'seeding')
    const config = makeEnrichConfig()
    db.prepare('UPDATE http_runs SET config = ? WHERE id = ?').run(JSON.stringify(config), runId)
    queue.err = new Error('the queue is down')
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
    } finally { onFollowQueued(() => {}); queue.err = null }
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
    queue.err = null
    const before = queue.calls.length
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
      assert.equal(queue.calls.length, before, 'zero-seeded run does not enqueue')
      assert.deepEqual(cells(sid, 'Status'), [CONDITION_NOT_MET, '✅ Kept'])
      assert.deepEqual(cells(sid, 'F'), ['empty', 'has:✅ Kept'])
      assert.deepEqual(queuedIndexes(sid, paid), [], 'zero paid auto-runs queued')
    } finally { onFollowQueued(() => {}); queue.err = null }
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
    queue.err = null
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
    } finally { onFollowQueued(() => {}); queue.err = null }

    // Enqueue-failure path: drops seed span before clear writes one clear span, restores cells, keeps F intact.
    const sid2 = makeAutorunSheet()
    const row0Id2 = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND row_index = 0').pluck().get(sid2) as string
    assert.ok('ok' in await startFormulaColumn(uid, sid2, { column: 'F', formula: f }))
    await idle(sid2)
    const paid2 = addPaid(sid2, 'Paid', 'enrichment', 'F', 1)
    const autoId2 = addHttpAuto(sid2)
    queue.err = new Error('the queue is down')
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
    } finally { queue.err = null }
  })

await closeWalCheckpointer()
finish('run-start-derived-enrich')
