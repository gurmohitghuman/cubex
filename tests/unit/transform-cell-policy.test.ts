// What transform_column writes follows the policy of every other cell write (lib/transform-ops.ts
// transformedCell, as formula/cells.ts): C0 and BIDI controls dropped, at most CELL_MAX_ENRICHMENT characters,
// and no lone surrogate half. Checked on the values each page hands SQLite (captured off the page's UPDATE),
// since SQLite itself stores U+FFFD for a lone half. A template longer than CELL_MAX_BASIC is refused.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import opsMod from '../../server/src/lib/transform-ops'
import constMod from '../../server/src/lib/constants'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { applyCellOp, transformedCell } = opsMod as typeof import('../../server/src/lib/transform-ops')
const { CELL_MAX_BASIC, CELL_MAX_ENRICHMENT } = constMod as typeof import('../../server/src/lib/constants')
type Params = import('../../server/src/services/column-transform').TransformParams

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

// Every value a page's UPDATE binds, in order.
const bound: unknown[] = []
const prepare = db.prepare.bind(db)
db.prepare = ((sql: string) => {
  const stmt = prepare(sql)
  if (!sql.startsWith('UPDATE rows SET data = json_set(data, ?, ?)')) return stmt
  const run = stmt.run.bind(stmt)
  Object.assign(stmt, { run: (...a: unknown[]) => { bound.push(a[1]); return run(...a) } })
  return stmt
}) as typeof db.prepare

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const EMOJI = '\u{1F600}'
const RLO = '\u202E'
const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const wellFormed = (s: unknown) => typeof s === 'string' && !LONE_HALF.test(s)
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
let made = 0
function sheet(rows: Array<Record<string, string>>): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
    .run(id, tid, uid, `S${made}`, made++, JSON.stringify(Object.keys(rows[0])))
  const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  rows.forEach((r, i) => insert.run(uuid(), id, uid, i, JSON.stringify(r)))
  return id
}
// The values the call bound, and its answer.
async function written(p: Params): Promise<unknown[]> {
  bound.length = 0
  const out = await transformColumn(uid, p)
  assert.ok('ok' in out, JSON.stringify(out).slice(0, 300))
  return [...bound]
}

async function main() {
  await check('transformedCell: controls and BIDI dropped, lone halves become U+FFFD, the enrichment cap', () => {
    assert.equal(transformedCell(`invoice${RLO}fdp.exe\u0000\u0007`), 'invoicefdp.exe')
    assert.equal(transformedCell('a\tb\nc'), 'a\tb\nc')
    assert.equal(transformedCell(`x${EMOJI}y`), `x${EMOJI}y`)
    assert.equal(transformedCell('\uD83D'), '�')
    assert.equal(transformedCell('a\uDE00b'), 'a�b')
    const long = transformedCell('n'.repeat(CELL_MAX_ENRICHMENT + 5))
    assert.ok(long.length <= CELL_MAX_ENRICHMENT && long.endsWith('[truncated]'), String(long.length))
  })

  await check('template: its BIDI and control characters are not written, nor those of the cells it reads',
    async () => {
    const id = sheet([{ Name: `ann${RLO}`, Note: 'x' }])
    assert.deepEqual(await written({ sheetId: id, operation: 'template', template: `invoice${RLO}{{Name}}\u0001.exe`,
      targetColumn: 'File' }), ['invoiceann.exe'])
  })

  await check('template: repeating a long cell writes at most CELL_MAX_ENRICHMENT characters', async () => {
    const id = sheet([{ Note: 'n'.repeat(CELL_MAX_BASIC) }])
    const [cell] = await written({ sheetId: id, operation: 'template', template: '{{Note}}'.repeat(125),
      targetColumn: 'Big' }) as string[]
    assert.ok(cell.length <= CELL_MAX_ENRICHMENT && cell.endsWith('[truncated]'), String(cell.length))
  })

  await check('template: one longer than CELL_MAX_BASIC is refused, writing nothing', async () => {
    const id = sheet([{ Note: 'x' }])
    bound.length = 0
    const out = await transformColumn(uid,
      { sheetId: id, operation: 'template', template: 'x'.repeat(CELL_MAX_BASIC + 1), targetColumn: 'T' })
    assert.deepEqual(out, { fail: 'invalid', error: 'template too long (max 8,000 characters).' })
    assert.deepEqual(bound, [])
  })

  await check('regex_extract and split cut a surrogate pair in two; no lone half is written', async () => {
    assert.ok(!wellFormed(applyCellOp('regex_extract', EMOJI, { pattern: '(.)' })), 'the op itself cuts the pair')
    assert.ok(!wellFormed(applyCellOp('split', `${EMOJI}x`, { pattern: '\uDE00' })), 'the op itself cuts the pair')
    const id = sheet([{ S: `${EMOJI}x` }, { S: `a${EMOJI}` }])
    const extracted = await written({ sheetId: id, operation: 'regex_extract', sourceColumn: 'S', pattern: '(.)$',
      targetColumn: 'Last' })
    const parts = await written({ sheetId: id, operation: 'split', sourceColumn: 'S', pattern: '\uDE00',
      targetColumn: 'Part' })
    assert.deepEqual(extracted, ['x', '�'])
    assert.deepEqual(parts, ['�', 'a�'])
  })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-cell-policy assertions passed.')
    process.exit(0)
  })
