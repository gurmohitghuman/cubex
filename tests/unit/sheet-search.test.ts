// Over 200 lines: one fixture sheet (view filter, hidden column, run words) shared by every search check.
// Search in the grid on a migrated throwaway DB, against a plain JavaScript
// walk of the same rows: the next and previous match through the active view
// (its filter, its hidden column), wrapping round, starting at a focused cell,
// each match's place in the view, the count and how many come before; and the
// SQL that drops rows first never drops one JavaScript would match.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import searchMod from '../../server/src/services/sheet-search'
import planMod from '../../server/src/services/sheet-search-plan'
import needleMod from '../../server/src/lib/sheet-search/needle'
import viewsMod from '../../server/src/services/view-store'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { findMatch, countMatches } = searchMod as typeof import('../../server/src/services/sheet-search')
const { prefilterSql } = planMod as typeof import('../../server/src/services/sheet-search-plan')
const { cellMatches, likePiece } = needleMod as typeof import('../../server/src/lib/sheet-search/needle')
const { listViews } = viewsMod as typeof import('../../server/src/services/view-store')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
const COLUMNS = ['A', 'B', 'Hidden', 'Keep', 'Status']
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(COLUMNS))
const CELLS = ['Acme GmbH', 'nothing', 'ACME', 'İSTANBUL ALİ', 'Kelvin \u212A', 'say "acme"', 'c:\\acme\\x',
  'MÜNCHEN', 'line\nbreak acme', '😀 acme', '1,000', '', 'Ali Baba', 'acmé', 'company', 'ΟΔΟΣ']
const MARKS = ['', '❌ Error: acme failed', '⏳ Processing...', '⏭️ Not found', 'acme done', '✅ Found']
const N = 9000
const rows: Array<{ row: number; data: Record<string, string> }> = []
db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const data = { A: CELLS[i % CELLS.length], B: CELLS[(i * 7 + 3) % CELLS.length], Hidden: 'acme hidden',
      Keep: i % 3 ? 'y' : 'n', Status: MARKS[i % MARKS.length] }
    rows.push({ row: i * 3, data })
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
      .run(uuid(), sid, uid, i * 3, JSON.stringify(data))
  }
})()
// The view: Keep is "y" (a column filter), Hidden hidden.
listViews(sid, uid)
db.prepare("UPDATE sheet_views SET hidden_columns = '[\"Hidden\"]' WHERE sheet_id = ?").run(sid)
db.prepare('UPDATE sheets SET column_filters = ? WHERE id = ?')
  .run(JSON.stringify({ Keep: { type: 'eq', value: 'Y' } }), sid)
const SEARCHED = ['A', 'B', 'Keep', 'Status']

type M = { row: number; column: string; position: number }
function reference(q: string): M[] {
  const needle = q.trim().toLowerCase()
  const out: M[] = []
  let position = 0
  for (const r of rows) {
    if (r.data.Keep.trim().toLowerCase() !== 'y') continue
    for (const c of SEARCHED) if (cellMatches(r.data[c], needle)) out.push({ row: r.row, column: c, position })
    position++
  }
  return out
}
const v = () => db.prepare('SELECT data_version, row_generation FROM sheets WHERE id = ?').get(sid) as
  { data_version: number; row_generation: number }
const find = async (q: string, opts: Partial<Parameters<typeof findMatch>[2]> = {}) => {
  const r = await findMatch(sid, uid, { q, ...opts })
  assert.ok('ok' in r, JSON.stringify(r))
  return r.ok
}
const strip = (m: M | null) => m && { row: m.row, column: m.column, position: m.position }

const NEEDLES = ['acme', ' ACME ', 'ali', 'kelvin k', 'k', '"acme"', '\\acme', 'münchen', 'ü', '😀', 'İ', 'nchen',
  'company', 'zzz', '1,0', 'break', 'οδος', 'ς']
await check('the first match from the top, then next all the way round, through the view', async () => {
  for (const q of NEEDLES) {
    const all = reference(q)
    let at = (await find(q)).match
    assert.deepEqual(strip(at), all[0] ?? null, q)
    const steps = Math.min(all.length, 12)
    for (let i = 1; i <= steps && at; i++) {
      const next = await find(q, { from: at, versions: v() })
      assert.deepEqual(strip(next.match), all[i % all.length], `${q} step ${i}`)
      assert.equal(next.wrapped, i === all.length, `${q} wrapped at ${i}`)
      at = next.match
    }
  }
})
await check('previous goes back, and from the first match wraps to the last', async () => {
  for (const q of ['acme', 'ali', 'münchen']) {
    const all = reference(q)
    const last = await find(q, { from: all[0], back: true })
    assert.deepEqual(strip(last.match), all[all.length - 1], q)
    assert.equal(last.wrapped, true)
    const k = Math.min(5, all.length - 1)
    const before = await find(q, { from: all[k], back: true, versions: v() })
    assert.deepEqual(strip(before.match), all[k - 1], q)
  }
})
await check('a search from a focused cell finds that cell first; a row outside the view counts as passed', async () => {
  const all = reference('acme')
  assert.deepEqual(strip((await find('acme', { from: all[7], inclusive: true })).match), all[7])
  assert.deepEqual(strip((await find('acme', { from: all[7] })).match), all[8])
  const hiddenRow = rows.find(r => r.data.Keep === 'n')!
  const after = all.find(m => m.row > hiddenRow.row)!
  assert.deepEqual(strip((await find('acme', { from: { row: hiddenRow.row, column: 'A' } })).match), after)
})
await check('a place counted on from a stale start is counted again from the top', async () => {
  const all = reference('acme')
  const wrong = { ...all[20], position: 3 }
  const stale = { data_version: v().data_version + 1, row_generation: v().row_generation }
  assert.equal((await find('acme', { from: wrong, versions: stale })).match!.position, all[21].position)
})
await check('the count stops at the cap and says how many come before a match', async () => {
  for (const q of ['acme', 'ali', 'zzz', '😀']) {
    const all = reference(q)
    const r = await countMatches(sid, uid, { q, at: all[Math.min(3, all.length - 1)] })
    assert.ok('ok' in r)
    assert.equal(r.ok.total, all.length, q)
    assert.equal(r.ok.capped, false)
    if (all.length) assert.equal(r.ok.before, Math.min(3, all.length - 1), q)
  }
})
await check('the text to search is checked', async () => {
  assert.ok('fail' in await findMatch(sid, uid, { q: '   ' }))
  assert.ok('fail' in await findMatch(sid, uid, { q: 'x'.repeat(201) }))
  assert.ok('fail' in await findMatch(sid, uid, { q: 'acme', viewId: 'another view' }))
})
await check('text LIKE can\'t look for (Cyrillic, "ß") is folded once per row before each column', async () => {
  const f = prefilterSql('москва', ['X', 'Y'])
  assert.match(f.sql, /^instr\(replace\(cubex_fold\(data\), char\(962\), char\(963\)\), \?\) > 0 AND /)
  assert.equal(likePiece('москва', false), '')
})
await check('LIKE pieces: no "k", no "i" that could be "İ", no JSON escapes in the whole-row piece', () => {
  assert.equal(likePiece('acme gmbh', true), 'acme gmbh')
  assert.equal(likePiece('ali', true), 'al')
  assert.equal(likePiece('alix', true), 'alix')
  assert.equal(likePiece('kai', true), 'a')
  assert.equal(likePiece('münchen', true), 'nchen')
  assert.equal(likePiece('日本語', true), '日本語')
  assert.equal(likePiece('ü', true), '')
  assert.equal(likePiece('say "acme"', true), 'say ')
  assert.equal(likePiece('say "acme"', false), 'say "acme"')
})

// The prefilter never drops a row JavaScript matches: random cells and texts.
await check('the SQL prefilter keeps every row that matches (random cells, tricky characters)', () => {
  const POOL = ['a', 'b', 'k', 'K', 'i', 'I', '\u0130', '\u212A', 'ü', 'Ü', 'ß', '"', '\\', '\n', ' ', '%', '_',
    '😀', 'ς', 'Σ', '\u0307', 'é', 'E\u0301', 'М', 'м', 'Ё', 'ё', 'Ω', 'ω']
  let seed = 7
  const rnd = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n }
  const word = (len: number) => Array.from({ length: len }, () => POOL[rnd(POOL.length)]).join('')
  db.exec('CREATE TEMP TABLE fuzz (data TEXT)')
  const cells = Array.from({ length: 400 }, () => ({ X: word(1 + rnd(8)), Y: word(1 + rnd(5)) }))
  for (const c of cells) db.prepare('INSERT INTO fuzz (data) VALUES (?)').run(JSON.stringify(c))
  for (let t = 0; t < 400; t++) {
    // By code point, as typed text is (an HTTP query can't carry half an emoji).
    const source = [...cells[rnd(cells.length)].X.toLowerCase()]
    const start = rnd(source.length)
    const piece = source.slice(start, start + 1 + rnd(4)).join('')
    const needle = (t % 4 === 0 ? word(1 + rnd(3)) : piece).toLowerCase().trim()
    if (!needle) continue
    const f = prefilterSql(needle, ['X', 'Y'])
    const kept = new Set(db.prepare(`SELECT rowid FROM fuzz WHERE ${f.sql}`).pluck().all(...f.params) as number[])
    cells.forEach((c, i) => {
      if (cellMatches(c.X, needle) || cellMatches(c.Y, needle)) {
        assert.ok(kept.has(i + 1), `dropped ${JSON.stringify(c)} for ${JSON.stringify(needle)}`)
      }
    })
  }
})

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nAll sheet-search assertions passed.')
