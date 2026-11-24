// Every statement in the server that adds rows to a sheet or removes them calls rowsChanged (lib/rows-changed.ts),
// so a row count made before it (lib/row-counts.ts) is never taken as current. It reads server/src: in each file, the
// statements that insert into, delete from or replace into rows, or move rows to another sheet (comments left out),
// against its rowsChanged( calls. A file with more statements than calls fails, naming the file, unless it is listed
// below with why its statements add or remove no row. Helpers that run such a statement (removeRows,
// upsertCellsBatch) are covered in their own file.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'server/src'
// File → why its row statements change no sheet's row count.
const ADD_NO_ROW: Record<string, string> = {
  'routes/sheets-data-write.ts': 'its upsert writes only rows its transaction found (existingRowSet): it adds none',
}
const WRITES = [
  /\b(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO\s+rows\b/gi,
  /\bDELETE\s+FROM\s+rows\b/gi,
  /\bUPDATE\s+rows\s+SET\s+(?:(?!\bWHERE\b)[^;`'"])*\bsheet_id\s*=/gi,
]

const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [])
// Comments out (a line's // only where it starts the line or follows a space, so a URL in a string stays).
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

let failures = 0
const found: string[] = []
for (const file of files(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/')
  const src = code(fs.readFileSync(file, 'utf8'))
  const writes = WRITES.reduce((n, re) => n + (src.match(re)?.length ?? 0), 0)
  if (writes === 0) continue
  found.push(`${rel} (${writes})`)
  const calls = src.match(/\browsChanged\(/g)?.length ?? 0
  if (calls >= writes) continue
  if (ADD_NO_ROW[rel]) { console.log(`      ${rel}: ${ADD_NO_ROW[rel]}`); continue }
  failures++
  console.log(`FAIL ${rel}: ${writes} statement(s) adding or removing rows, ${calls} rowsChanged call(s)`)
}
for (const listed of Object.keys(ADD_NO_ROW)) {
  try { fs.statSync(path.join(ROOT, listed)) } catch { failures++; console.log(`FAIL ${listed} is listed but gone`) }
}
console.log(`      ${found.length} files with row statements: ${found.join(', ')}`)
assert.ok(found.length >= 16, 'the search found fewer files than the 16 it found when written')
if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('ok   every statement adding or removing rows calls rowsChanged')
console.log('all passed')
