// Every SQL statement in the server must prepare against the schema the
// migrations build. SQL lives in strings, so the typechecker can't see a query
// that names a dropped column — it only fails at runtime, on whichever route
// happens to run it. SQLite resolves every table and column at prepare time, so
// preparing each statement against a fresh in-memory DB catches them all
// without running anything.
//
// Statements are found with the TypeScript AST: the first argument of every
// .prepare(...) / .exec(...) call that is a string or template literal.
// Template substitutions (a table name, a WHERE fragment) are tried with a few
// stand-ins; a statement fails only if it fails under all of them.
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import Database from 'better-sqlite3'

const ROOT = process.cwd()
const SERVER_SRC = path.join(ROOT, 'server/src')
const MIGRATIONS = path.join(SERVER_SRC, 'db/migrations')

const db = new Database(':memory:')
for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
  db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
}
// Created at runtime rather than by a migration.
db.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT)')
db.exec('CREATE TEMP TABLE _sort_idx_map (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)')

// Stand-ins for ${...}: placeholders, literals, identifiers, the run and result
// tables (run-lifecycle/queue pick ai_runs or http_runs, sort-results picks
// ai_results or http_results), and SQL fragments (empty or a SET/WHERE clause).
const STAND_INS = ['?', "'x'", 'id', '1', `'$."x"'`, 'ai_runs', 'http_runs', 'ai_results', 'http_results', '', 'name = ?']

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}

let checked = 0
const failures: string[] = []

for (const file of sourceFiles(SERVER_SRC)) {
  const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && (node.expression.name.text === 'prepare' || node.expression.name.text === 'exec')
        && node.arguments.length > 0) {
      const arg = node.arguments[0]
      let variants: string[] | null = null
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        variants = [arg.text]
      } else if (ts.isTemplateExpression(arg)) {
        variants = STAND_INS.map(s => arg.head.text + arg.templateSpans.map(span => s + span.literal.text).join(''))
      }
      if (variants) {
        checked++
        let lastError = ''
        const ok = variants.some(sql => {
          try { db.prepare(sql); return true } catch (e) { lastError = (e as Error).message; return false }
        })
        if (!ok) {
          const line = src.getLineAndCharacterOfPosition(node.getStart()).line + 1
          failures.push(`${path.relative(ROOT, file)}:${line}  ${lastError}\n    ${variants[0].replace(/\s+/g, ' ').trim().slice(0, 160)}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
}

if (checked < 100) throw new Error(`Only found ${checked} SQL statements; the extractor is probably broken.`)
if (failures.length > 0) {
  throw new Error(`${failures.length} SQL statement(s) don't match the schema:\n${failures.join('\n')}`)
}
console.log(`ok   all ${checked} SQL statements in server/src prepare against the migrated schema`)
