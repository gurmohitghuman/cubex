// Shared fixture for the run-start derived tests (run-start-derived.test.ts, run-start-derived-enrich.test.ts):
// starting a run tells clean, formula and lookup columns reading its columns by span (lib/derived-spans.ts). A
// throwaway database (run-undo-kit.ts), the job queue replaced by a stand-in (`queue`: what was enqueued, and an
// error to throw instead), scenes with readers and paid auto-runs, and helpers reading spans, marks and queues.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'

export const queue = { err: null as Error | null, calls: [] as unknown[][] }
const { Sidequest } = createRequire(path.resolve('server/src/queue.ts'))('sidequest')
Sidequest.build = () => ({
  enqueue: async (...args: unknown[]) => {
    if (queue.err) throw queue.err
    queue.calls.push(args)
    return {}
  },
})

import formulaMod from '../../server/src/services/formula-column'
import cleanMod from '../../server/src/services/clean-column'
import lookupMod from '../../server/src/services/lookup-column'
import followMod from '../../server/src/services/derived-follow'
import entryMod from '../../server/src/services/autorun-entry'
import enrichToolMod from '../../server/src/lib/enrich-tool'
import enrichCfgMod from '../../server/src/lib/enrich-run-config'
import type { EnrichRunConfig } from '../../server/src/lib/enrich-run-config'
const { startFormulaColumn } = formulaMod as typeof import('../../server/src/services/formula-column')
const { startCleanColumn } = cleanMod as typeof import('../../server/src/services/clean-column')
const { startLookupColumn } = lookupMod as typeof import('../../server/src/services/lookup-column')
const { derivedFollowTick } = followMod as typeof import('../../server/src/services/derived-follow')
const { entryFor, loadEntry } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { normalizeTool } = enrichToolMod as typeof import('../../server/src/lib/enrich-tool')
const { requestToolOf } = enrichCfgMod as typeof import('../../server/src/lib/enrich-run-config')

export const kit = undoKit('run-start-derived')
const { db, uid, idle, sheet, cells } = kit
console.error = () => {}

const FIND_FIXTURE = 'tests/mock-treg/fixtures/catalog/endpoints/treg.people.email.find.json'
const FIND_TOOL = normalizeTool(JSON.parse(fs.readFileSync(FIND_FIXTURE, 'utf8')))!

export const until = async (what: string, cond: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !cond();) {
    if (Date.now() > end) throw new Error(`Timed out waiting until ${what}`)
    await new Promise(r => setTimeout(r, 15))
  }
}
export const entry = (sid: string, col: string) => entryFor(sid, uid, col)!.id
export const spans = (sid: string) => db.prepare('SELECT COUNT(*) FROM derived_spans WHERE sheet_id = ?')
  .pluck().get(sid) as number
export const marks = (sid: string) => db.prepare(`SELECT COUNT(*) FROM derived_span_marks
  WHERE autorun_id IN (SELECT id FROM autorun_columns WHERE sheet_id = ?)`).pluck().get(sid) as number
export const queuedIndexes = (sid: string, entryId: string) => db.prepare(`SELECT r.row_index FROM autorun_pending p
  JOIN rows r ON r.id = p.row_id WHERE p.autorun_id = ? ORDER BY r.row_index`).pluck().all(entryId) as number[]
export const toldIndexes = (sid: string, col: string) => db.prepare(`SELECT r.row_index FROM derived_span_marks m
  JOIN derived_spans s ON s.id = m.span_id, json_each(s.rowids) j JOIN rows r ON r.rowid = j.value
  WHERE m.autorun_id = ? ORDER BY r.row_index`).pluck().all(entry(sid, col)) as number[]
export const tick = (sid: string, col: string) => derivedFollowTick(loadEntry(entry(sid, col))!)
export const addPaid = (
  sid: string, status: string, kind: 'http' | 'enrichment', input: string, watermark: number,
) => {
  const id = uuid()
  db.prepare(`INSERT INTO autorun_columns
    (id, user_id, sheet_id, status_column, kind, input_columns, watermark_row_index)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, uid, sid, status, kind, JSON.stringify([input]), watermark)
  return id
}

export function insertRun(
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

export async function setupDerivedScene() {
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

export function makeEnrichConfig(): EnrichRunConfig {
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

export async function setupEnrichScene() {
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
export async function run(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log('ok  ', name)
  } catch (e) {
    failures++
    console.log('FAIL', name, '\n ', (e as Error).stack)
  }
}
export function finish(name: string): void {
  if (failures > 0) {
    console.log(`${failures} ${name} assertion(s) failed`)
    process.exitCode = 1
  } else {
    console.log(`All ${name} assertions passed.`)
  }
}
