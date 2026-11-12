// Every SQL statement in server/src that writes sheets.column_order reaches forgetUnlistedTransformPasses after it,
// or is on ALLOWED with why it can't drop a listed name. A column that leaves column_order is gone for good, and
// so is its unfinished transform_column pass (services/column-transform-pass-moves.ts): a writer that drops a
// name without that call leaves a pass that a column made or renamed under that name later would take.
//
// What it checks, on the source only (the TypeScript parser, no database). Each .ts file under server/src that
// names column_order or holds "UPDATE sheets" or "INTO sheets" is parsed, and each string expression folded into
// one text: literals, templates and `+` chains, any other part (a `${x}`, a call) read as "${}", a `?:` as both of
// its branches. A text writes column_order when it holds UPDATE sheets with a SET (up to WHERE) naming column_order
// or holding a "${}"; INSERT or REPLACE INTO sheets with no column list, or naming column_order or a "${}" after
// it; or "column_order =" (a SET built in pieces). A writer reaches the call when the function holding it calls it
// after the write: as a statement of its own (not in an `if`, `&&` or callback beside it), in a block the write is
// inside, with no return in between. When that function doesn't, every call of it (in its own file, or in a file
// importing it from there, through re-exports too) must, up to 4 calls up; a function also used as a value
// (passed on, imported under another name) or never called fails. Files are told apart by one form of their path
// ('/' between parts), so it reads the same on Windows.
// Each .sql file in server/src/db/migrations is read too, comments dropped and split at each ';' (a trigger's
// inner statements are statements of their own): an UPDATE of sheets whose SET names column_order, or an INSERT
// or REPLACE INTO sheets naming it or with no column list, is a writer. SQL can't call the function, so such a
// statement passes only on ALLOWED (its fn SQL_FN), with why; none writes it today.
// An ALLOWED entry fails when it matches no writer, more than one, or one whose own function calls it (an allowed
// writer's callers aren't followed); a writer matched by two entries fails too.
// What it can't see: that the two run inside one transaction (true when the function is a transaction's callback
// or called in one, which it doesn't check), a statement assembled from several variables or read from a file, a
// file naming neither column_order nor "UPDATE/INTO sheets" in one piece, a method called on an object, a break,
// continue or caught throw between them; in the migrations, a table rebuilt under another name and renamed to
// sheets, a table name quoted or with its schema, a ';' inside a quoted string (it splits there), and SQL run from
// anywhere but server/src. The scan itself: column-order-scan-kit.ts.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  DYN, FILES, FORGET, ROOT, SCANNED, SQL_FILES, bindsFrom, callsOf, forgetsAfter, nearestFunction, parse,
  parsedCount, reaches, sqlWriters, textOf, tsWriters, type Writer,
} from './column-order-scan-kit'

// Writers that can't drop a listed name. Keyed by file, the named function holding the statement (SQL_FN for a
// migration's), and a piece of it; each must match exactly one writer that doesn't reach the call.
interface Allowed { file: string; fn: string; sql: string; why: string }
const ALLOWED: Allowed[] = [
  { file: 'lib/sheet-columns.ts', fn: 'getSheetColumns', sql: 'SET column_order',
    why: 'seeds a list for a sheet that has none (null or unreadable): no name was listed to drop' },
  { file: 'lib/sheet-columns.ts', fn: 'appendColumnsToOrder', sql: 'SET column_order',
    why: 'adds names only, after the stored list (seeded from the rows first when there is none)' },
  { file: 'lib/trash/column-restore.ts', fn: 'listAt', sql: 'SET column_order',
    why: 'lists a restored column again at its place: the stored list with that name put in, every name kept' },
  { file: 'services/column-delete.ts', fn: 'deleteSheetColumn', sql: 'SET column_order',
    why: 'drops only the deleted column, whose pass the delete moved onto its trash item (or deleted) before' },
  { file: 'services/column-rename.ts', fn: 'switchColumnName', sql: 'SET column_order',
    why: 'renames one name in place, and moves its pass to the new name in the same transaction' },
  { file: 'services/column-rename.ts', fn: 'switchColumnName', sql: `SET ${DYN} =`,
    why: 'sets empty_filter or column_filters (the two fields its loop names), never column_order' },
  { file: 'services/column-reorder.ts', fn: 'reorderSheetColumns', sql: 'SET column_order',
    why: 'the same names in a new order: a list missing one is refused (column-order-lists.test.ts)' },
  { file: 'services/setup-version-apply.ts', fn: 'writePlan', sql: 'SET column_order',
    why: 'mergeOrder keeps every name the sheet lists now, around the version\'s (column-order-lists.test.ts)' },
]

// Each writer against the allowlist: one that reaches FORGET, or is matched by exactly one entry; each entry
// matching exactly one writer.
function judge(writers: Writer[], allowed: Allowed[]): { problems: string[]; summary: string[] } {
  const problems: string[] = []
  const summary: string[] = []
  const matched = allowed.map(() => 0)
  for (const w of writers) {
    const entries = allowed.flatMap((a, i) => (a.file === w.file && a.fn === w.fn && w.sql.includes(a.sql) ? [i] : []))
    entries.forEach(i => matched[i]++)
    const at = `${w.at} (${w.fn}): ${w.sql.slice(0, 70)}`
    // An allowed writer's callers aren't followed (getSheetColumns has a hundred): only its own function is read.
    const own = w.node && nearestFunction(w.node)
    const why = entries.length ? (own && forgetsAfter(w.node!, own) ? null : 'allowed')
      : w.node ? reaches(w.node) : 'a migration can\'t call it'
    if (why === null) {
      summary.push(`calls ${FORGET}  ${at}`)
      if (entries.length) problems.push(`${at} calls ${FORGET} now: drop its ALLOWED entry`)
    } else if (entries.length === 1) {
      summary.push(`allowed         ${at}`)
    } else {
      problems.push(entries.length ? `${at} matches ${entries.length} ALLOWED entries: make them narrower`
        : `${at} writes column_order without reaching ${FORGET} (${why}). Call it after the write, in its `
          + 'transaction, or add an ALLOWED entry saying why it never drops a listed name.')
    }
  }
  allowed.forEach((a, i) => {
    const entry = `ALLOWED entry ${a.file} ${a.fn} "${a.sql}"`
    if (matched[i] === 0) problems.push(`${entry} matches no writer: drop it`)
    if (matched[i] > 1) {
      problems.push(`${entry} matches ${matched[i]} writers: an entry allows one statement, give each its own`)
    }
  })
  return { problems, summary }
}

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const fakeFile = (file: string, text: string) => ts.createSourceFile(`${ROOT}/${file}`, text, ts.ScriptTarget.Latest,
  true)

check('every writer in server/src and its migrations reaches the call or is allowed, each entry used once', () => {
  const started = performance.now()
  const writers = FILES.filter(f => SCANNED.test(textOf(f)!)).flatMap(f => tsWriters(parse(f)))
  const sql = SQL_FILES.flatMap(f => sqlWriters(f, fs.readFileSync(f, 'utf8')))
  const { problems, summary } = judge([...writers, ...sql], ALLOWED)
  console.log(summary.join('\n'))
  console.log(`${writers.length} writers in ${parsedCount()} parsed .ts files, ${sql.length} in ${SQL_FILES.length} `
    + `migrations, in ${Math.round(performance.now() - started)} ms`)
  assert.ok(SQL_FILES.length > 50, `${SQL_FILES.length} migrations found`)
  assert.deepEqual(problems, [])
})

check('a call is followed across files whatever separators the paths name them with (TypeScript writes "/", '
  + 'path.join on Windows "\\")', () => {
  const name = 'applyTransferColumnOrder'
  const decl = `${ROOT}/services/transfer-columns.ts`
  const caller = `${ROOT}/services/rows-transfer.ts`
  const backslashed = path.win32.normalize(decl)
  const mixed = `${path.win32.join(ROOT, 'services')}/transfer-columns.ts`
  assert.ok(backslashed.includes('\\') && mixed.includes('\\') && mixed.includes('/'), mixed)
  const seen = (d: string) => {
    const calls = callsOf(name, d)
    return typeof calls === 'string' ? calls : calls.map(c => `${c.getSourceFile().fileName}:${c.getStart()}`)
  }
  const found = seen(decl)
  assert.ok(Array.isArray(found) && found.length > 0 && found.every(c => c.startsWith(caller)), String(found))
  assert.deepEqual(seen(backslashed), found)
  assert.deepEqual(seen(mixed), found)
  assert.equal(bindsFrom(path.win32.normalize(caller), name, decl), true, 'a caller named with "\\"')
  assert.equal(bindsFrom(caller, name, mixed), true, 'a declaration named with both')
})

check('an allowed entry matching two writers fails: a second SET column_order in an allowed function', () => {
  const entry = ALLOWED.filter(a => a.fn === 'appendColumnsToOrder')
  const one = `export function appendColumnsToOrder(db, id, order) {
    db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(order, id)\n`
  const once = tsWriters(fakeFile('lib/sheet-columns.ts', `${one}}`))
  assert.equal(once.length, 1)
  assert.deepEqual(judge(once, entry).problems, [])
  const twice = tsWriters(fakeFile('lib/sheet-columns.ts', `${one}
    db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(order.slice(1), id)\n}`))
  assert.equal(twice.length, 2)
  assert.deepEqual(judge(twice, entry).problems, ['ALLOWED entry lib/sheet-columns.ts appendColumnsToOrder '
    + '"SET column_order" matches 2 writers: an entry allows one statement, give each its own'])
})

check('a migration statement writing column_order is a writer, and fails unless allowed', () => {
  const file = `${ROOT}/db/migrations/999_example.sql`
  const writes = [
    'UPDATE sheets SET column_order = \'[]\' WHERE id = \'x\'',
    'UPDATE OR IGNORE sheets SET name = name, column_order = NULL',
    'INSERT INTO sheets SELECT * FROM sheets_old',
    'INSERT OR REPLACE INTO sheets (id, column_order) VALUES (\'x\', \'[]\')',
    'CREATE TRIGGER t AFTER DELETE ON tables BEGIN UPDATE sheets SET column_order = NULL; END',
  ]
  for (const sql of writes) {
    const found = sqlWriters(file, `-- a note; with a semicolon\n\n${sql};\n`)
    assert.deepEqual(found.map(w => [w.at, w.fn]), [['db/migrations/999_example.sql:3', '(migration)']], sql)
    assert.match(judge(found, []).problems[0], /writes column_order without reaching .*a migration can't call it/)
    const allowed = { file: 'db/migrations/999_example.sql', fn: '(migration)', sql: 'sheets', why: 'example' }
    assert.deepEqual(judge(found, [allowed]).problems, [])
  }
  const others = [
    'UPDATE sheets SET active_view_id = NULL WHERE column_order = \'[]\'',
    'INSERT INTO sheets (id, name) VALUES (\'x\', \'y\')',
    'INSERT INTO sheets_new SELECT * FROM sheets',
    'CREATE TABLE sheets (id TEXT, column_order TEXT)',
    '/* UPDATE sheets SET column_order = NULL; */ SELECT 1',
    '-- UPDATE sheets SET column_order = NULL\nSELECT 1',
  ]
  for (const sql of others) assert.deepEqual(sqlWriters(file, `${sql};`), [], sql)
})

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('All column-order-writers assertions passed.')
