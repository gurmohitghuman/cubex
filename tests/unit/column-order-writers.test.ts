// Over 200 lines: one guard, read top to bottom: its allowlist, the scan for writers and the call follower.
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
// (passed on, imported under another name) or never called fails. An ALLOWED entry fails when it matches no
// writer, or one whose own function calls it (an allowed writer's callers aren't followed); a writer matched by two
// entries fails too.
// What it can't see: that the two run inside one transaction (true when the function is a transaction's callback
// or called in one, which it doesn't check), a statement assembled from several variables or read from a file, a
// file naming neither column_order nor "UPDATE/INTO sheets" in one piece, a method called on an object, a break,
// continue or caught throw between them, and SQL in the migrations (triggers).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve('server/src')
const FORGET = 'forgetUnlistedTransformPasses'
const DYN = '${}'
const MAX_UP = 4

// Writers that can't drop a listed name. Keyed by file, the named function holding the statement, and a piece of
// it; each must match exactly one writer that doesn't reach the call.
const ALLOWED = [
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

const tsFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [])
const FILES = tsFiles(ROOT)
const texts = new Map(FILES.map(f => [f, fs.readFileSync(f, 'utf8')]))
const parsed = new Map<string, ts.SourceFile>()
const parse = (f: string) => parsed.get(f) ?? parsed.set(f, ts.createSourceFile(f, texts.get(f)!,
  ts.ScriptTarget.Latest, true)).get(f)!
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/')
const where = (n: ts.Node) => { const s = n.getSourceFile(); const at = s.getLineAndCharacterOfPosition(n.getStart())
  return `${rel(s.fileName)}:${at.line + 1}` }

const isPlus = (n: ts.Node): n is ts.BinaryExpression =>
  ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken
// A string expression as one text; `dyn`: its parts that aren't text, searched for statements of their own.
function fold(n: ts.Node, dyn: ts.Node[]): string {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => fold(s.expression, dyn)
    + s.literal.text).join('')
  if (ts.isParenthesizedExpression(n)) return fold(n.expression, dyn)
  if (isPlus(n)) return fold(n.left, dyn) + fold(n.right, dyn)
  if (ts.isConditionalExpression(n)) return `${fold(n.whenTrue, dyn)} ${fold(n.whenFalse, dyn)}`
  dyn.push(n)
  return DYN
}
const isText = (n: ts.Node) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
  || ts.isTemplateExpression(n) || isPlus(n)
function writesOrder(sql: string): boolean {
  const update = /\bUPDATE\s+(?:OR\s+\w+\s+)?sheets\b\s+SET\b(.*?)(?:\bWHERE\b|$)/is.exec(sql)
  if (update && (/\bcolumn_order\b/i.test(update[1]) || update[1].includes(DYN))) return true
  const insert = /\b(?:INSERT|REPLACE)\b(?:\s+OR\s+\w+)?\s+INTO\s+sheets\b(.*)$/is.exec(sql)
  if (insert && (!/^\s*\(/.test(insert[1]) || /\bcolumn_order\b/i.test(insert[1]) || /^\s*\([^)]*\$\{\}/
    .test(insert[1]))) return true
  return /\bcolumn_order\s*=(?!=)/i.test(sql)
}

interface Writer { file: string; fn: string; sql: string; node: ts.Node }
const writers: Writer[] = []
function scan(n: ts.Node): void {
  if (!isText(n)) { ts.forEachChild(n, scan); return }
  const dyn: ts.Node[] = []
  const sql = fold(n, dyn).replace(/\s+/g, ' ')
  if (writesOrder(sql)) writers.push({ file: rel(n.getSourceFile().fileName), fn: namedFunction(n), sql, node: n })
  dyn.forEach(scan)
}

const nearestFunction = (n: ts.Node): ts.SignatureDeclaration | undefined => {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p
}
// A function's own name: declared, a method, or the variable it is the value of.
function nameOf(f: ts.SignatureDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(f) || ts.isMethodDeclaration(f)) && f.name) return f.name.getText()
  if (f.parent && ts.isVariableDeclaration(f.parent) && f.parent.initializer === f) return f.parent.name.getText()
}
function namedFunction(n: ts.Node): string {
  for (let f = nearestFunction(n); f; f = nearestFunction(f)) { const name = nameOf(f); if (name) return name }
  return '(module)'
}

// In `fn`, a call to FORGET after `at`: a statement of its own whose block holds `at`, no return in between.
function forgetsAfter(at: ts.Node, fn: ts.SignatureDeclaration): boolean {
  const calls: ts.CallExpression[] = []
  const returns: ts.Node[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && n !== fn) return
    if (ts.isReturnStatement(n)) returns.push(n)
    if (ts.isCallExpression(n) && n.expression.getText() === FORGET) calls.push(n)
    ts.forEachChild(n, walk)
  }
  walk(fn)
  return calls.some(c => {
    if (c.getStart() < at.getEnd() || returns.some(r => r.getStart() > at.getEnd() && r.getStart() < c.getStart())) {
      return false
    }
    const statement = ts.isAwaitExpression(c.parent) ? c.parent.parent : c.parent
    if (!ts.isExpressionStatement(statement)) return false
    const block = statement.parent
    for (let p: ts.Node | undefined = at; p; p = p.parent) if (p === block) return true
    return false
  })
}

const resolve = (from: string, spec: string): string | undefined => {
  const base = path.resolve(path.dirname(from), spec)
  return spec.startsWith('.') ? [base, `${base}.ts`, path.join(base, 'index.ts')].find(f => texts.has(f)) : undefined
}
// Whether the name `name` in `file` is the function declared in `decl`: its own file, or imported from it (also
// through files that pass it on with export ... from).
function bindsFrom(file: string, name: string, decl: string, depth = 0): boolean {
  if (file === decl) return true
  return depth < MAX_UP && parse(file).statements.some(st => {
    if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier) return false
    const from = resolve(file, (st.moduleSpecifier as ts.StringLiteral).text)
    const list = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : st.exportClause
    const named = list && (ts.isNamedImports(list) || ts.isNamedExports(list))
      ? list.elements.some(e => (e.propertyName ?? e.name).text === name) : ts.isExportDeclaration(st)
    return from !== undefined && named && bindsFrom(from, name, decl, depth + 1)
  })
}

// Every use of the function `name` declared in `decl`, across server/src: its calls, or why it can't be followed.
function callsOf(name: string, decl: string): ts.Node[] | string {
  const calls: ts.Node[] = []
  let value: string | undefined
  const files = FILES.filter(f => new RegExp(`\\b${name}\\b`).test(texts.get(f)!) && bindsFrom(f, name, decl))
  for (const f of files) {
    const visit = (n: ts.Node): void => {
      const p = n.parent
      if (ts.isIdentifier(n) && n.text === name && !(ts.isPropertyAccessExpression(p) && p.name === n)) {
        const declared = (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === n
        const named = (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && !p.propertyName
        if (ts.isCallExpression(p) && p.expression === n) calls.push(p)
        else if (!declared && !named && !ts.isTypeQueryNode(p)) value ??= `used as a value at ${where(n)}`
      }
      ts.forEachChild(n, visit)
    }
    visit(parse(f))
  }
  return value ?? (calls.length ? calls : 'never called')
}

// Null when `at` reaches FORGET after it, else why not.
function reaches(at: ts.Node, up = 0): string | null {
  const fn = nearestFunction(at)
  if (!fn) return 'at module level'
  if (forgetsAfter(at, fn)) return null
  const name = nameOf(fn)
  if (!name) return `in an unnamed function (${where(fn)}) that doesn't call ${FORGET} after it`
  if (up === MAX_UP) return `more than ${MAX_UP} calls up`
  const calls = callsOf(name, fn.getSourceFile().fileName)
  if (typeof calls === 'string') return `${name} is ${calls}`
  for (const c of calls) { const why = reaches(c, up + 1); if (why) return `${name}, called at ${where(c)}: ${why}` }
  return null
}

const started = performance.now()
const SCANNED = /\bcolumn_order\b|\b(?:UPDATE|INTO)\s+(?:OR\s+\w+\s+)?sheets\b/i
for (const f of FILES) if (SCANNED.test(texts.get(f)!)) scan(parse(f))
const problems: string[] = []
const used = new Set<number>()
const summary: string[] = []
for (const w of writers) {
  const entries = ALLOWED.flatMap((a, i) => (a.file === w.file && a.fn === w.fn && w.sql.includes(a.sql) ? [i] : []))
  entries.forEach(i => used.add(i))
  const at = `${where(w.node)} (${w.fn}): ${w.sql.slice(0, 70)}`
  // An allowed writer's callers aren't followed (getSheetColumns has a hundred): only its own function is read.
  const own = nearestFunction(w.node)
  const why = entries.length ? (own && forgetsAfter(w.node, own) ? null : 'allowed') : reaches(w.node)
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
ALLOWED.forEach((a, i) => {
  if (!used.has(i)) problems.push(`ALLOWED entry ${a.file} ${a.fn} "${a.sql}" matches no writer: drop it`)
})
console.log(summary.join('\n'))
console.log(`${writers.length} writers, ${parsed.size} files parsed, in ${Math.round(performance.now() - started)} ms`)
assert.deepEqual(problems, [])
console.log('All column-order-writers assertions passed.')
