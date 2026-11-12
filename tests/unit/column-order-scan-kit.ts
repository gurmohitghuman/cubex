// The scan behind column-order-writers.test.ts (what it reads and can't see: that test's header): the statements
// in server/src that write sheets.column_order, in its .ts files and its migrations' .sql files, and whether a .ts
// writer's function reaches forgetUnlistedTransformPasses after it, following its callers up. Every path it
// compares or keys a map by is in one form, key(): TypeScript names a source file with '/' whatever it was given,
// path.join on Windows answers '\'.
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const FORGET = 'forgetUnlistedTransformPasses'
export const DYN = '${}'
// A migration's statements have no function: their writers carry this one.
export const SQL_FN = '(migration)'
const MAX_UP = 4

export const key = (f: string) => f.replace(/\\/g, '/')
export const ROOT = key(path.resolve('server/src'))
const under = (dir: string, ext: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? under(`${dir}/${e.name}`, ext) : e.name.endsWith(ext) ? [`${dir}/${e.name}`] : [])
export const FILES = under(ROOT, '.ts')
export const SQL_FILES = under(`${ROOT}/db/migrations`, '.sql')
const texts = new Map(FILES.map(f => [f, fs.readFileSync(f, 'utf8')]))
export const textOf = (f: string) => texts.get(key(f))
const parsed = new Map<string, ts.SourceFile>()
export function parse(f: string): ts.SourceFile {
  const k = key(f)
  if (!texts.has(k)) throw new Error(`not a .ts file under server/src: ${f}`)
  return parsed.get(k) ?? parsed.set(k, ts.createSourceFile(k, texts.get(k)!, ts.ScriptTarget.Latest, true)).get(k)!
}
export const parsedCount = () => parsed.size
export const rel = (f: string) => key(path.relative(ROOT, key(f)))
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
// `pieces`: a .ts text may be part of a statement built in pieces, so "column_order =" alone counts there.
function writesOrder(sql: string, pieces: boolean): boolean {
  const update = /\bUPDATE\s+(?:OR\s+\w+\s+)?sheets\b\s+SET\b(.*?)(?:\bWHERE\b|$)/is.exec(sql)
  if (update && (/\bcolumn_order\b/i.test(update[1]) || update[1].includes(DYN))) return true
  const insert = /\b(?:INSERT|REPLACE)\b(?:\s+OR\s+\w+)?\s+INTO\s+sheets\b(.*)$/is.exec(sql)
  if (insert && (!/^\s*\(/.test(insert[1]) || /\bcolumn_order\b/i.test(insert[1]) || /^\s*\([^)]*\$\{\}/
    .test(insert[1]))) return true
  return pieces && /\bcolumn_order\s*=(?!=)/i.test(sql)
}

// `node`: a .ts writer's string expression; a migration's has none.
export interface Writer { file: string; fn: string; sql: string; at: string; node?: ts.Node }
export const SCANNED = /\bcolumn_order\b|\b(?:UPDATE|INTO)\s+(?:OR\s+\w+\s+)?sheets\b/i
export function tsWriters(source: ts.SourceFile): Writer[] {
  const found: Writer[] = []
  const scan = (n: ts.Node): void => {
    if (!isText(n)) { ts.forEachChild(n, scan); return }
    const dyn: ts.Node[] = []
    const sql = fold(n, dyn).replace(/\s+/g, ' ')
    if (writesOrder(sql, true)) {
      found.push({ file: rel(n.getSourceFile().fileName), fn: namedFunction(n), sql, at: where(n), node: n })
    }
    dyn.forEach(scan)
  }
  scan(source)
  return found
}
// A .sql file's statements, comments blanked (lines kept) and split at each ';', a trigger's inner ones too.
export function sqlWriters(file: string, text: string): Writer[] {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)
  const found: Writer[] = []
  let offset = 0
  for (const part of plain.split(';')) {
    const sql = part.replace(/\s+/g, ' ').trim()
    const line = plain.slice(0, offset + part.search(/\S|$/)).split('\n').length
    if (writesOrder(sql, false)) found.push({ file: rel(file), fn: SQL_FN, sql, at: `${rel(file)}:${line}` })
    offset += part.length + 1
  }
  return found
}

export const nearestFunction = (n: ts.Node): ts.SignatureDeclaration | undefined => {
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
export function forgetsAfter(at: ts.Node, fn: ts.SignatureDeclaration): boolean {
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
  if (!spec.startsWith('.')) return undefined
  const base = key(path.resolve(path.dirname(key(from)), spec))
  return [base, `${base}.ts`, `${base}/index.ts`].find(f => texts.has(f))
}
// Whether the name `name` in `file` is the function declared in `decl`: its own file, or imported from it (also
// through files that pass it on with export ... from).
export function bindsFrom(file: string, name: string, decl: string, depth = 0): boolean {
  if (key(file) === key(decl)) return true
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
export function callsOf(name: string, decl: string): ts.Node[] | string {
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
export function reaches(at: ts.Node, up = 0): string | null {
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
