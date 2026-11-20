// Shared fixture for the tests of the rows a stopped run's ⏳ clear tells as spans (derived-span-*.test.ts,
// lib/derived-spans.ts): a sheet whose Answer column holds earlier answers; formula F reading Answer and F2
// reading F; two auto-runs that cost (Hook reading Answer, Enriched reading F2), which a clear's spans must never
// reach; and an HTTP run on Answer, stopped with its ⏳ on every row, its journal keeping the answers. F and F2
// are saved while the ⏳ is there (they read it as empty), or before the run (`before`: they were right). The
// clear puts the answers back and tells F the rows by span; F follows, and F2 follows F.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import cellsMod from '../../server/src/lib/placeholder-cells'
import writeMod from '../../server/src/lib/run-cells-write'
import markMod from '../../server/src/lib/autorun-mark'
import formulaMod from '../../server/src/services/formula-column'
import followMod from '../../server/src/services/derived-follow'
import entryMod from '../../server/src/services/autorun-entry'
const { clearProcessingPlaceholders, seedProcessingPlaceholders } =
  cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { writeRunCells } = writeMod as typeof import('../../server/src/lib/run-cells-write')
const { markAutorunInputs } = markMod as typeof import('../../server/src/lib/autorun-mark')
const { startFormulaColumn } = formulaMod as typeof import('../../server/src/services/formula-column')
const { derivedFollowTick } = followMod as typeof import('../../server/src/services/derived-follow')
const { entryFor, loadEntry } = entryMod as typeof import('../../server/src/services/autorun-entry')

export const FORMULA = '{{Answer}} ? "has " + {{Answer}} : "empty"'
// What F and F2 hold for an answer.
export const fOf = (answer: unknown) => (answer ? `has ${answer}` : 'empty')
export type Run = { kind: 'http'; id: string }

export function spanKit(name: string) {
  const kit = undoKit(name)
  const { db, uid, idle, sheet, cells } = kit
  const formula = async (sid: string, column: string, f: string) => {
    const out = await startFormulaColumn(uid, sid, { column, formula: f })
    assert.ok('ok' in out, JSON.stringify(out))
    await idle(sid)
  }
  const entry = (sid: string, column: string) => entryFor(sid, uid, column)!.id
  const indexOf = (sid: string) => new Map((db.prepare('SELECT id, row_index FROM rows WHERE sheet_id = ?')
    .all(sid) as Array<{ id: string; row_index: number }>).map(r => [r.id, r.row_index]))

  // An HTTP run on Answer over every row (or `targets`), its journal keeping what the cells held. Stopped, its
  // clear to come (placeholder_work 'clearing'), unless `going`.
  async function runOn(sid: string, opts: { going?: boolean; targets?: number[] } = {}): Promise<Run> {
    const id = uuid()
    db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,placeholder_work)
      VALUES (?,?,?,'{}',?,'Answer',?)`).run(id, sid, uid, opts.going ? 'running' : 'cancelled',
      opts.going ? null : 'clearing')
    const last = db.prepare('SELECT MAX(row_index) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
    await seedProcessingPlaceholders({ run: { kind: 'http', id }, sheetId: sid, userId: uid, columns: ['Answer'],
      targets: opts.targets ?? null, lastRow: last, live: () => true })
    return { kind: 'http', id }
  }
  const readers = async (sid: string) => {
    await formula(sid, 'F', FORMULA)
    await formula(sid, 'F2', '{{F}} + "!"')
  }
  // The scene: n rows, Answer `answer(i)`.
  async function scene(n: number, opts: { answer?: (i: number) => string; before?: boolean } = {}) {
    const answer = opts.answer ?? ((i: number) => `Old ${i}`)
    const sid = sheet(Array.from({ length: n }, (_, i) => ({ Name: `n${String(i).padStart(5, '0')}`,
      Answer: answer(i) })), ['Name', 'Answer', 'Hook', 'Enriched'])
    if (opts.before) await readers(sid)
    const run = await runOn(sid)
    if (!opts.before) await readers(sid)
    // Each has looked at every row there (its fence at the top row): only a row written now is queued for it.
    const paid = (status: string, kind: string, input: string) => {
      const id = uuid()
      db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns,
        watermark_row_index) VALUES (?,?,?,?,?,?,?)`).run(id, uid, sid, status, kind, JSON.stringify([input]), n - 1)
      return id
    }
    const want = Array.from({ length: n }, (_, i) => (opts.before ? fOf(answer(i)) : 'empty'))
    assert.deepEqual(cells(sid, 'F'), want, 'F as it was before the clear')
    return { sid, run, paid: [paid('Hook', 'http', 'Answer'), paid('Enriched', 'enrichment', 'F2')] }
  }

  // The run's clear, `then` after each slice. Then the run lets Answer go, as its clear's end does
  // (lib/run-placeholders.ts): F waits for that. Returns how many slices it took.
  async function clear(sid: string, run: Run, then?: (slice: number) => void | Promise<void>) {
    let slices = 0
    const after: Array<Promise<void> | void> = []
    await clearProcessingPlaceholders(sid, uid, ['Answer'], () => { after.push(then?.(++slices)) }, run)
    await Promise.all(after)
    db.prepare('UPDATE http_runs SET placeholder_work = NULL WHERE id = ?').run(run.id)
    return slices
  }
  // A person (or a run's worker, `run`) writes cells in row `i`, and every column reading them hears of it.
  function write(sid: string, i: number, cells: Array<[string, string]>, run?: Run) {
    db.transaction(() => {
      if (run) writeRunCells(run, sid, uid, i, cells)
      else {
        for (const [c, v] of cells) {
          db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE sheet_id = ? AND row_index = ?')
            .run(`$."${c}"`, v, sid, i)
        }
      }
      markAutorunInputs(sid, uid, cells.map(([c]) => c), { indexes: [i] })
    }).immediate()
  }

  // The row indexes told `column` by span (each once per span), and queued for an entry.
  const told = (sid: string, column: string) => (db.prepare(`SELECT r.row_index FROM derived_span_marks m
      JOIN derived_spans s ON s.id = m.span_id, json_each(s.rowids) j JOIN rows r ON r.rowid = j.value
    WHERE m.autorun_id = ? ORDER BY r.row_index`).pluck().all(entry(sid, column)) as number[])
  const queued = (sid: string, entryId: string) => {
    const at = indexOf(sid)
    return (db.prepare('SELECT row_id FROM autorun_pending WHERE autorun_id = ?').pluck().all(entryId) as string[])
      .map(id => at.get(id)).sort((a, b) => a! - b!)
  }
  const marks = (sid: string) => db.prepare(`SELECT COUNT(*) FROM derived_span_marks
    WHERE autorun_id IN (SELECT id FROM autorun_columns WHERE sheet_id = ?)`).pluck().get(sid) as number
  const spans = (sid: string) => db.prepare('SELECT COUNT(*) FROM derived_spans WHERE sheet_id = ?')
    .pluck().get(sid) as number
  // A reader's marks: how far it got in each of its spans, oldest first.
  const progress = (sid: string, column: string) => db.prepare(`SELECT done FROM derived_span_marks
    WHERE autorun_id = ? ORDER BY span_id`).pluck().all(entry(sid, column)) as number[]
  // F, then F2, tick by tick (as kicks, or with `tick` as the auto-run sweep, run them), until neither has
  // queued rows or spans left (a tick ends after CLEAN_FOLLOW_TICK_MS).
  async function follow(sid: string, columns = ['F', 'F2'],
    tick: (id: string) => Promise<void> = id => derivedFollowTick(loadEntry(id)!)) {
    for (const c of columns) {
      const id = entry(sid, c)
      const work = () => queued(sid, id).length + progress(sid, c).length
      for (let n = 0; work() > 0 && n < 50; n++) await tick(id)
      assert.equal(work(), 0, `${c} caught up`)
    }
  }
  // F right for what Answer holds now (or `f`), F2 for F, every span worked out, and each paid auto-run queued
  // for exactly its `loud` rows (those a person or a run wrote: never a clear's).
  function right(sid: string, paid: string[], opts: { f?: string[]; loud?: number[][] } = {}) {
    const f = opts.f ?? cells(sid, 'Answer').map(fOf)
    assert.deepEqual(cells(sid, 'F'), f, 'F follows Answer')
    assert.deepEqual(cells(sid, 'F2'), f.map(v => `${v}!`), 'F2 follows F')
    assert.deepEqual([marks(sid), spans(sid)], [0, 0], 'every span worked out')
    assert.deepEqual(paid.map(p => queued(sid, p)), opts.loud ?? [[], []], 'the paid auto-runs hear only of `loud`')
  }
  return { ...kit, formula, entry, runOn, scene, clear, write, told, queued, marks, spans, progress, follow, right }
}
