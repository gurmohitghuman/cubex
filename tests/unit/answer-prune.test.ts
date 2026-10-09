// Stored answers (services/answer-prune*.ts, answer-store-size.ts) and treg's
// reachability note (services/treg-reach.ts) against a migrated throwaway DB:
// a row enriched again prunes the raw part of the column's older answers at
// that row only (output and _treg stay, $prunedAt is written), a single
// tool's answer and other columns are never touched, a busy sheet waits, a
// sort starts the pass over, "older than 90 days" prunes only runs that ended
// before the cutoff, and the count adds up the answers' bytes.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import pruneMod from '../../server/src/services/answer-prune'
import ageMod from '../../server/src/services/answer-prune-age'
import sizeMod from '../../server/src/services/answer-store-size'
import reachMod from '../../server/src/services/treg-reach'
import busyMod from '../../server/src/lib/sheet-busy'
import storeMod from '../../server/src/lib/answer-store'
import colsMod from '../../server/src/lib/http-columns'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { pruneSupersededAnswers } = pruneMod as typeof import('../../server/src/services/answer-prune')
const { startAgePrune, agePruneRunning } = ageMod as typeof import('../../server/src/services/answer-prune-age')
const { countStoredAnswers, storedAnswersView } =
  sizeMod as typeof import('../../server/src/services/answer-store-size')
const { noteTregReach, tregReach, tregAnswered } = reachMod as typeof import('../../server/src/services/treg-reach')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { readStored } = storeMod as typeof import('../../server/src/lib/answer-store')
const { renameHttpRunColumnRefs } = colsMod as typeof import('../../server/src/lib/http-columns')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const waitFor = async (what: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (what()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return false
}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name) VALUES (?,?,?,?)').run(sheetId, tableId, uid, 'S')

const waterfall = JSON.stringify({ responseMapping: [], enrichment: { kind: 'waterfall' } })
const single = JSON.stringify({ responseMapping: [], enrichment: { kind: 'single' } })
let tick = 0
function run(column: string, config: string, status = 'completed', ago = 0): string {
  const id = uuid()
  // created_at a second apart, so "older" is unambiguous.
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, created_at, updated_at)
    VALUES (?,?,?,?,?,?, datetime('now', ?), datetime('now', ?))`)
    .run(id, sheetId, uid, config, status, column, `-${ago * 86400 + 1000 - tick++} seconds`,
      `-${ago * 86400} seconds`)
  return id
}
const routed = (n: number) =>
  ({ output: { email: `p${n}@x.com` }, _treg: { outcome: 'hit' }, raw: { big: 'y'.repeat(500) } })
function answer(runId: string, row: number, body: unknown) {
  db.prepare(`INSERT INTO http_results (id, run_id, user_id, row_index, response_data, status)
    VALUES (?,?,?,?,?, 'completed')`).run(uuid(), runId, uid, row, JSON.stringify(body))
}
const stored = (runId: string, row: number) => readStored(JSON.parse(db.prepare(
  'SELECT response_data FROM http_results WHERE run_id = ? AND row_index = ?').pluck().get(runId, row) as string))
const flag = (runId: string) =>
  db.prepare('SELECT answers_pruned FROM http_runs WHERE id = ?').pluck().get(runId) as number

async function main() {
  // Email: A (oldest) answered rows 0-4, S a single tool on row 1, B answered rows 1 and 3 again.
  const a = run('Email', waterfall)
  for (let r = 0; r < 5; r++) answer(a, r, routed(r))
  const s = run('Email', single)
  answer(s, 1, { raw: 'provider field', _cubex: {} })
  const other = run('Company', waterfall)
  answer(other, 1, routed(1))
  const b = run('Email', waterfall)
  answer(b, 1, routed(11))
  answer(b, 3, routed(13))
  const live = run('Email', waterfall, 'running')
  answer(live, 0, routed(20))

  // A busy sheet waits.
  let release!: () => void
  const held = withSheetBusy(sheetId, 'sorting', () => new Promise<void>(r => { release = r }))
  await pruneSupersededAnswers()
  check('a busy sheet leaves the pass for later', flag(b) === 0 && stored(a, 1).prunedAt === null)
  release()
  await held

  // A sort since the cursor was saved: the pass starts over.
  db.prepare('UPDATE http_runs SET prune_cursor = 10, prune_generation = 999 WHERE id = ?').run(b)
  await pruneSupersededAnswers()
  const a1 = stored(a, 1)
  check('the older answer at a row enriched again loses raw', a1.prunedAt !== null
    && !('raw' in (a1.body as object)))
  const kept = a1.body as { output: unknown; _treg: object }
  check('...and keeps output and _treg',
    JSON.stringify(kept.output) === '{"email":"p1@x.com"}' && 'outcome' in kept._treg)
  check('rows not enriched again keep their raw', [0, 2, 4].every(r => stored(a, r).prunedAt === null))
  check('row 3 pruned too (after the restart)', stored(a, 3).prunedAt !== null)
  check('a single tool\'s answer is never pruned', stored(s, 1).prunedAt === null
    && (stored(s, 1).body as { raw?: unknown }).raw === 'provider field')
  check('another column is untouched', stored(other, 1).prunedAt === null)
  check('the newest answers keep raw', stored(b, 1).prunedAt === null && stored(b, 3).prunedAt === null)
  check('ended runs are done, a running one waits', flag(b) === 1 && flag(a) === 1 && flag(live) === 0)
  const plain = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status) VALUES (?,?,?,'{}','completed')`)
    .run(plain, sheetId, uid)
  await pruneSupersededAnswers()
  check('a plain HTTP run is marked done', flag(plain) === 1)

  // An output column reads the runs linked to it: a newer run that dropped one
  // doesn't replace the older answer for it, one that keeps them all does.
  const link = (runId: string, cols: string[]) => cols.forEach(c => db.prepare(`INSERT INTO http_column_associations
    (id, sheet_id, user_id, master_column_name, extracted_column_name, run_id) VALUES (?,?,?,?,?,?)`)
    .run(uuid(), sheetId, uid, 'Title', c, runId))
  const wide = run('Title', waterfall)
  answer(wide, 7, routed(7))
  link(wide, ['Job', 'Seniority'])
  const narrow = run('Title', waterfall)
  answer(narrow, 7, routed(17))
  link(narrow, ['Job'])
  await pruneSupersededAnswers()
  check('a newer run that dropped an output keeps the older answer whole', stored(wide, 7).prunedAt === null)
  const full = run('Title', waterfall)
  answer(full, 7, routed(27))
  link(full, ['Job', 'Seniority', 'Team'])
  await pruneSupersededAnswers()
  check('one that keeps every output prunes both older answers',
    stored(wide, 7).prunedAt !== null && stored(narrow, 7).prunedAt !== null && stored(full, 7).prunedAt === null)

  // A rename moves runs to another column: a new column with the old name
  // never prunes them (checked against the runs as they are, not a cache).
  const q1 = run('Q', waterfall)
  answer(q1, 9, routed(9))
  await pruneSupersededAnswers()
  db.transaction(() => renameHttpRunColumnRefs(sheetId, uid, 'Q', 'Q2'))()
  const q2 = run('Q', waterfall)
  answer(q2, 9, routed(19))
  await pruneSupersededAnswers()
  check('a renamed column\'s answer is not pruned by a new column with its old name',
    stored(q1, 9).prunedAt === null && flag(q2) === 1)

  // Older than 90 days: only runs that ended before the cutoff.
  const old = run('Phone', waterfall, 'completed', 120)
  for (let r = 0; r < 3; r++) answer(old, r, routed(r))
  const recent = run('Phone', waterfall, 'completed', 10)
  answer(recent, 5, routed(5))
  const started = startAgePrune(uid, 90)
  check('the prune starts', 'ok' in started)
  check('a second prune is refused while one runs', 'fail' in startAgePrune(uid, 90) || !agePruneRunning(uid))
  check('the prune finishes', await waitFor(() => !agePruneRunning(uid)))
  check('answers of runs that ended before the cutoff are pruned',
    [0, 1, 2].every(r => stored(old, r).prunedAt !== null))
  check('recent answers stay whole', stored(recent, 5).prunedAt === null && stored(a, 0).prunedAt === null)
  const view = storedAnswersView(uid)
  check('the view reports the prune', view.prune?.status === 'done' && view.prune.pruned === 3)

  // The count: every enrichment answer's bytes.
  countStoredAnswers(uid, true)
  const expect = db.prepare(`SELECT COUNT(*) AS n, SUM(octet_length(response_data)) AS b FROM http_results r
    JOIN http_runs h ON h.id = r.run_id WHERE json_type(h.config, '$.enrichment') IS NOT NULL`).get() as
    { n: number; b: number }
  check('the count finishes', await waitFor(() => !storedAnswersView(uid).counting))
  const v = storedAnswersView(uid)
  check(`the count adds up (${v.answers} answers, ${v.bytes} bytes)`, v.answers === expect.n && v.bytes === expect.b)
  check('the count says when', typeof v.countedAt === 'string' && !Number.isNaN(Date.parse(v.countedAt!)))

  // treg's reachability: written when it changes, only with a key saved.
  check('treg answered: a refusal counts', tregAnswered({ status: 402, callId: null, tregError: true }))
  check('no answer is unreachable', !tregAnswered({ status: null, callId: null, tregError: false }))
  check('a bare 503 is unreachable', !tregAnswered({ status: 503, callId: null, tregError: false }))
  check('a cut-off body is unreachable',
    !tregAnswered({ status: 200, incomplete: true, callId: 'c', tregError: false }))
  db.prepare(`INSERT INTO settings (id, user_id, treg_token_encrypted) VALUES (?, ?, 'enc')`).run(uuid(), uid)
  check('nothing before a call', tregReach() === null)
  noteTregReach(uid, false)
  const first = tregReach()
  check('unreachable after a failed call', first?.treg === 'unreachable')
  db.prepare(`UPDATE settings SET treg_reach_since = '2020-01-01 00:00:00' WHERE user_id = ?`).run(uid)
  noteTregReach(uid, false)
  check('the same outcome doesn\'t write again', tregReach()?.since === '2020-01-01T00:00:00Z')
  noteTregReach(uid, true)
  check('ok once treg answers', tregReach()?.treg === 'ok')
  db.prepare('UPDATE settings SET treg_token_encrypted = NULL WHERE user_id = ?').run(uid)
  check('no report without a saved key', tregReach() === null)

  if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
  console.log('\nall passed')
  process.exit(0)
}
main().catch(err => { console.error(err); process.exit(1) })
