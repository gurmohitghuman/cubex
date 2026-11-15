// No WAL checkpoint runs on the API thread outside the places listed below (lib/bulk-slices.ts says why): every
// background bulk writer copies its WAL back on the checkpoint worker's thread. On the source only (the
// TypeScript parser, so comments never count), in each .ts file under server/src:
// - a string or template literal naming wal_checkpoint, in any mode but NOOP (which only reads the WAL's size),
//   or a `.checkpoint(...)` call, matches a CHECKPOINTS entry;
// - a literal setting wal_autocheckpoint (`wal_autocheckpoint = ...`) matches an AUTO entry;
// - a call of withoutAutoCheckpoint (SQLite's own checkpoint off for a commit, so someone must copy the WAL back)
//   matches a NO_AUTO entry.
// Each entry is a file, how many it holds and why; a file holding more or fewer than its count fails, as does one
// not listed. A fixture proves each rule catches its case. What it can't see: SQL built from pieces at run time.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

interface Entry { file: string; count: number; why: string }
const CHECKPOINTS: Entry[] = [
  { file: 'server/src/lib/wal-checkpoint-worker.ts', count: 1, why: 'the worker\'s own connection, on its thread' },
  { file: 'server/src/lib/wal-checkpointer.ts', count: 1,
    why: 'no worker (it couldn\'t start, or stopped twice): on this thread as before, logged once' },
  { file: 'server/src/lib/bulk-slices.ts', count: 1, why: 'off the main thread only (the lookup worker)' },
  { file: 'server/src/services/lookup-maintain.ts', count: 1,
    why: 'on the lookup worker\'s thread; its fallback on the API thread goes through the checkpointer' },
]
const AUTO: Entry[] = [
  { file: 'server/src/lib/db.ts', count: 1, why: 'the connection\'s setting, DB_AUTO_CHECKPOINT_FRAMES' },
  { file: 'server/src/lib/slices.ts', count: 2, why: 'withoutAutoCheckpoint: off for one commit, then back' },
  { file: 'server/src/lib/bulk-slices.ts', count: 1, why: 'holdAutoCheckpoint: off while bulk writers run' },
]
const NO_AUTO: Entry[] = [
  { file: 'server/src/lib/bulk-slices.ts', count: 2, why: 'the bulk writers\' slices, on either thread' },
  { file: 'server/src/services/column-transform-pages.ts', count: 1, why: 'transform_column\'s pages (walRoom)' },
  { file: 'server/src/services/lookup-maintain.ts', count: 1, why: 'on the lookup worker\'s thread' },
]

type Rule = 'checkpoint' | 'auto' | 'no-auto'
// A literal's text: a template's pieces joined, its ${...} left out.
function literal(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => s.literal.text).join(' ')
  return null
}
function scan(name: string, text: string): Rule[] {
  const found: Rule[] = []
  const walk = (n: ts.Node): void => {
    const s = literal(n)
    if (s !== null) {
      for (const m of s.matchAll(/wal_checkpoint\b\s*(\(\s*(\w*))?/gi)) {
        if (m[2]?.toUpperCase() !== 'NOOP') found.push('checkpoint')
      }
      for (const _ of s.matchAll(/wal_autocheckpoint\s*=/gi)) found.push('auto')
    }
    if (ts.isCallExpression(n)) {
      const f = n.expression
      if (ts.isPropertyAccessExpression(f) && f.name.text === 'checkpoint') found.push('checkpoint')
      if (ts.isIdentifier(f) && f.text === 'withoutAutoCheckpoint') found.push('no-auto')
    }
    if (!ts.isTemplateExpression(n)) ts.forEachChild(n, walk)
  }
  walk(ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true))
  return found
}

let failures = 0
const ok = (label: string, fn: () => void) => {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const root = process.cwd()
const files: string[] = []
const walkDir = (dir: string): void => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walkDir(p)
    else if (p.endsWith('.ts')) files.push(path.relative(root, p).split(path.sep).join('/'))
  }
}
walkDir(path.join(root, 'server/src'))
const counts = new Map<string, Map<Rule, number>>()
for (const f of files) {
  for (const r of scan(f, fs.readFileSync(path.join(root, f), 'utf8'))) {
    const m = counts.get(f) ?? new Map<Rule, number>()
    m.set(r, (m.get(r) ?? 0) + 1)
    counts.set(f, m)
  }
}
const check = (rule: Rule, entries: Entry[]) => {
  const got = [...counts].filter(([, m]) => m.has(rule)).map(([f, m]) => `${f}: ${m.get(rule)}`).sort()
  assert.deepEqual(got, entries.map(e => `${e.file}: ${e.count}`).sort())
}

ok('the fixture: each rule catches its case, and only that', () => {
  const src = `
    db.pragma('wal_checkpoint(PASSIVE)'); db.exec('PRAGMA wal_checkpoint'); db.pragma(\`wal_checkpoint(\${m})\`)
    db.checkpoint(); db.pragma(\`wal_autocheckpoint = \${n}\`); db.exec('PRAGMA wal_autocheckpoint=0')
    withoutAutoCheckpoint(() => 1)
    // db.pragma('wal_checkpoint(TRUNCATE)') in a comment
    db.pragma('wal_checkpoint(NOOP)'); db.prepare('PRAGMA wal_checkpoint( noop )')
    db.pragma('wal_autocheckpoint', { simple: true }); const checkpoint = 1; walCheckpoint(); auto.withoutAutoCheckpoint
  `
  assert.deepEqual(scan('fixture.ts', src).sort(),
    ['auto', 'auto', 'checkpoint', 'checkpoint', 'checkpoint', 'checkpoint', 'no-auto'])
})
ok('server/src was read', () => assert.ok(files.length > 200 && files.includes('server/src/lib/bulk-slices.ts')))
ok('WAL checkpoints run only where listed (CHECKPOINTS)', () => check('checkpoint', CHECKPOINTS))
ok('SQLite\'s own checkpoint is set only where listed (AUTO)', () => check('auto', AUTO))
ok('SQLite\'s own checkpoint is turned off for a commit only where listed (NO_AUTO)', () => check('no-auto', NO_AUTO))

if (failures > 0) { console.error(`${failures} bulk-wal-guard assertion(s) failed`); process.exit(1) }
console.log('All bulk-wal-guard assertions passed.')
