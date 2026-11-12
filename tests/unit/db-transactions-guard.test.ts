// Every transaction in server/src and tests/unit is begun one of two ways (lib/db-transaction.ts says why): with
// `.immediate()` when it writes, or with readTransaction when it only reads, each read listed in READS below with
// why it only reads. A deferred transaction that reads before it writes fails at once with "database is locked"
// when another connection wrote in between (write-lock-journal.test.ts proves it), and busy_timeout never helps.
//
// What it checks, on the source only (the TypeScript parser, no database), in each .ts file under both folders:
// - each call of `<anything>.transaction(...)` is begun with .immediate(): called as `.transaction(f).immediate()`,
//   or kept in a const, not exported, whose every use (one at least, in the block declaring it) is
//   `<name>.immediate(...)`. A plain call, .exclusive(), .default(), the transaction passed on, kept in a let or
//   exported (its uses in other files aren't followed) fails;
// - each readTransaction call matches a READS entry (file, the named function holding it, how many it holds);
//   readTransaction used other than called, or renamed on import or destructuring, fails;
// - a transaction begun deferred on purpose matches a DEFERRED entry: `.transaction(f).deferred`, or an exec or
//   prepare whose first argument is a literal BEGIN (not BEGIN IMMEDIATE or EXCLUSIVE).
// An entry matching no call, or fewer calls than are there, fails. A fixture proves each rule catches its case.
// What it can't see: BEGIN built from pieces, `db['transaction']` or a `transaction` taken out of the connection
// (destructured, or bound as tests do to wrap it), and anything outside these two folders (tests/e2e, scripts).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

interface Entry { file: string; fn: string; count?: number; why: string }
const READS: Entry[] = [
  { file: 'server/src/services/answer-read.ts', fn: 'readAnswer', why: 'the row, its result and its calls' },
  { file: 'server/src/services/lookup-preview.ts', fn: 'previewLookupColumn', why: 'the keys and the rows they name' },
  { file: 'server/src/services/rows-by-id.ts', fn: 'readRowsById', why: 'the rows and their versions' },
  { file: 'server/src/services/rows-since.ts', fn: 'readRowsSince', why: 'a page of rows, versions and columns' },
  { file: 'server/src/services/waterfall-step-lookup.ts', fn: 'match', why: "a lookup step's match in the index" },
  { file: 'server/src/services/waterfall-trace.ts', fn: 'readWaterfallTrace', why: "a row's waterfall trace" },
  { file: 'server/src/services/saved-keys.ts', fn: 'saveImportedKeys', why: 'a dry run reads the saved keys only' },
]
// Transactions begun deferred on purpose.
const DEFERRED: Entry[] = [
  { file: 'server/src/lib/db-transaction.ts', fn: 'readTransaction', why: 'the read helper itself' },
  { file: 'tests/unit/write-lock-journal.test.ts', fn: '(top level)', count: 3,
    why: 'proves a deferred transaction that reads first fails at once, and one that writes first waits' },
  // A reader on a second connection keeping its snapshot across awaits, so the WAL can't start over.
  { file: 'tests/unit/transform-wal-answer.test.ts', fn: 'main', why: 'a reader holding old frames' },
  { file: 'tests/unit/transform-wal-wait.test.ts', fn: 'main', why: 'a reader holding old frames' },
  { file: 'tests/unit/wal-restart-worker.test.ts', fn: 'main', why: 'a reader holding old frames' },
]

interface Spot { file: string; fn: string; at: string }
interface Scan { bad: Array<Spot & { what: string }>; reads: Spot[]; deferred: Spot[]; begun: number }

// The named function holding a node: a function, a method, or a const or property holding a function.
function named(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isFunctionExpression(p)) && p.name) {
      return p.name.getText()
    }
    if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer
      && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) && n.pos >= p.initializer.pos) {
      return p.name.getText()
    }
  }
  return '(top level)'
}
const calledAs = (n: ts.Node, method: string) => ts.isPropertyAccessExpression(n.parent)
  && n.parent.name.text === method && ts.isCallExpression(n.parent.parent) && n.parent.parent.expression === n.parent
// A name after a dot or before a colon (`track.stop`, `{ stop: 1 }`), not a use of a variable.
const isMemberName = (n: ts.Identifier) => (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
  || ((ts.isPropertyAssignment(n.parent) || ts.isMethodDeclaration(n.parent) || ts.isPropertySignature(n.parent)
    || ts.isPropertyDeclaration(n.parent)) && n.parent.name === n)
// A const holding the transaction, each use of it in its block `<name>.immediate(...)`.
function keptImmediate(call: ts.CallExpression): boolean {
  const decl = call.parent
  if (!ts.isVariableDeclaration(decl) || decl.initializer !== call || !ts.isIdentifier(decl.name)) return false
  if (!(decl.parent.flags & ts.NodeFlags.Const)) return false
  // Exported, it can be begun in another file, which this doesn't follow.
  if (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) return false
  const name = decl.name.text
  let block: ts.Node = decl
  while (!ts.isBlock(block) && !ts.isSourceFile(block) && !ts.isModuleBlock(block)) block = block.parent
  let uses = 0, others = 0
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name && n !== decl.name && !isMemberName(n)) {
      if (calledAs(n, 'immediate')) uses++; else others++
    }
    ts.forEachChild(n, walk)
  }
  walk(block)
  return uses > 0 && others === 0
}

function scan(file: string, text: string): Scan {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: Scan = { bad: [], reads: [], deferred: [], begun: 0 }
  const spot = (n: ts.Node): Spot => ({ file, fn: named(n), at: `${file}:${src.getLineAndCharacterOfPosition(n
    .getStart()).line + 1}` })
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text
      if (method === 'transaction') {
        const p = n.parent
        if (calledAs(n, 'immediate') || keptImmediate(n)) out.begun++
        else if (ts.isPropertyAccessExpression(p) && p.name.text === 'deferred') out.deferred.push(spot(n))
        else out.bad.push({ ...spot(n), what: 'a transaction not begun with .immediate()' })
      }
      const sql = n.arguments[0]
      if ((method === 'exec' || method === 'prepare') && sql
        && (ts.isStringLiteral(sql) || ts.isNoSubstitutionTemplateLiteral(sql))
        && /^\s*BEGIN\b/i.test(sql.text) && !/^\s*BEGIN\s+(IMMEDIATE|EXCLUSIVE)\b/i.test(sql.text)) {
        out.deferred.push(spot(n))
      }
    }
    if (ts.isIdentifier(n) && n.text === 'readTransaction') {
      const p = n.parent
      if (ts.isCallExpression(p) && p.expression === n) out.reads.push(spot(n))
      else if (!ts.isFunctionDeclaration(p) && !((ts.isImportSpecifier(p) || ts.isBindingElement(p)) && p.name === n)) {
        out.bad.push({ ...spot(n), what: 'readTransaction used other than called' })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return out
}

// What the entries don't account for, and entries that match nothing or fewer calls than are there.
function unlisted(found: Spot[], entries: Entry[], kind: string): string[] {
  const problems: string[] = []
  for (const e of entries) {
    const at = found.filter(s => s.file === e.file && s.fn === e.fn)
    if (at.length !== (e.count ?? 1)) {
      problems.push(`${kind} entry ${e.file} ${e.fn} lists ${e.count ?? 1}, found ${at.length}`
        + (at.length ? `: ${at.map(s => s.at).join(', ')}` : ''))
    }
  }
  for (const s of found) {
    if (!entries.some(e => e.file === s.file && e.fn === s.fn)) problems.push(`${s.at}: ${kind} not listed (${s.fn})`)
  }
  return problems
}

const under = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? under(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : [])

// The fixture: each line of BAD is caught once, each of DEFERS is found deferred; GOOD holds nothing to catch
// and one read in `f`.
const BAD = [
  'db.transaction(() => 1)()',
  'const t = db.transaction(() => 1); t()',
  'const u = db.transaction(() => 1); u.immediate(); u()',
  'let v = db.transaction(() => 1); v.immediate()',
  'db.transaction(() => 1).exclusive()',
  'db.transaction(() => 1).default()',
  'run(db.transaction(() => 1))',
  'const r = readTransaction; r(() => 1)()',
  'export const e = db.transaction(() => 1); e.immediate()',
  "import { readTransaction as rt } from './db-transaction'; rt(() => 1)()",
  'const { readTransaction: rb } = mod; rb(() => 1)()',
]
const DEFERS = ['db.transaction(() => 1).deferred()', 'const d = db.transaction(() => 1).deferred', "db.exec('BEGIN')",
  'db.prepare(`BEGIN DEFERRED`).run()', "conn.exec(' begin transaction')"]
const GOOD = `db.transaction(() => 1).immediate()
const p = db.transaction((n: number) => n); p.immediate(2); p.immediate(3)
o.p(); ({ p: 1 })
function f() { return readTransaction(() => 1)() }
db.exec('BEGIN IMMEDIATE')
db.prepare("SELECT 'BEGIN'").get()`
for (const line of BAD) {
  const s = scan('fixture.ts', line)
  assert.equal(s.bad.length, 1, `the scan misses ${line}: ${JSON.stringify(s.bad)}`)
}
for (const line of DEFERS) {
  const s = scan('fixture.ts', line)
  assert.ok(s.bad.length === 0 && s.deferred.length === 1, `the scan doesn't find ${line} deferred`)
}
const good = scan('fixture.ts', GOOD)
assert.deepEqual(good.bad, [])
assert.deepEqual(good.reads.map(r => r.fn), ['f'])
assert.equal(good.begun, 2)
// Entries: an unlisted read, a stale entry and an entry listing fewer calls than are there each fail.
const twice = scan('fixture.ts', 'function g() { readTransaction(a)(); readTransaction(b)() }').reads
assert.equal(unlisted(twice, [], 'read').length, 2)
assert.equal(unlisted(twice, [{ file: 'fixture.ts', fn: 'g', why: '' }], 'read').length, 1)
assert.deepEqual(unlisted(twice, [{ file: 'fixture.ts', fn: 'g', count: 2, why: '' }], 'read'), [])
assert.equal(unlisted([], [{ file: 'fixture.ts', fn: 'g', why: '' }], 'read').length, 1)
console.log('ok   the fixture: each way of beginning a transaction otherwise is caught')

// The code.
const scans = ['server/src', 'tests/unit'].flatMap(under).map(f => {
  const file = f.split(path.sep).join('/')
  return scan(file, fs.readFileSync(f, 'utf8'))
})
const bad = scans.flatMap(s => s.bad).map(b => `${b.at}: ${b.what} (${b.fn})`)
const problems = [...bad, ...unlisted(scans.flatMap(s => s.reads), READS, 'read'),
  ...unlisted(scans.flatMap(s => s.deferred), DEFERRED, 'deferred')]
const begun = scans.reduce((n, s) => n + s.begun, 0)
console.log(`  ${scans.length} files: ${begun} transactions begun with .immediate(), ${READS.length} read entries`)
assert.ok(scans.length > 400 && begun > 100, 'the scan read the folders')
assert.deepEqual(problems, [], `transactions begun otherwise:\n${problems.join('\n')}`)
console.log('ok   every transaction in server/src and tests/unit is begun with .immediate() or listed as a read')
console.log('\ndb transactions guard: all passed')
