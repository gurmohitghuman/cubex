// A setup's resume against the setup sweep (services/setup-run-control.ts, setup-runner.ts), on a migrated
// throwaway database. Each run's job is queued through a stand-in for the queue library whose insert the test can
// hold, so a sweep or a control runs while a resume waits on it:
//   - a sweep while the resume waits on its run's job: the run stays pending (it was paused again, its job then
//     ran nothing, and the step waited with no end while the setup showed running);
//   - a pause while the resume waits on its first run's job: it pauses that run, and the second isn't resumed;
//   - a refusal after the first run was resumed (a column the second reads is held meanwhile): the setup is
//     paused again as it was, and the first run with it;
//   - a setup resumed during a sweep, after an older setup's turn (services/setup-sweep.ts): the sweep reads it
//     again at its turn, and leaves its run pending (the list read it paused).
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// The provider's model list, empty: a resume reads it first, and nothing here goes out.
const stand = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}') })
})
await new Promise<void>(r => stand.listen(0, '127.0.0.1', r))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(stand.address() as AddressInfo).port}/api/v1`

// Each job's insert: answered at once, or held until the test lets it go.
const queued: unknown[][] = []
let holding = false
let release: (() => void) | null = null
createRequire(path.resolve('server/src/queue.ts'))('sidequest').Sidequest.build = () => ({
  enqueue: (...args: unknown[]) => {
    queued.push(args)
    return holding ? new Promise(r => { release = () => { release = null; r({}) } }) : Promise.resolve({})
  },
})

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { seedProcessingPlaceholders } = await import('../../server/src/lib/placeholder-cells')
const { planApply } = await import('../../server/src/lib/setups/apply-plan')
const { sheetCandidates } = await import('../../server/src/services/setup-steps')
const { insertSetupRun, saveSteps, setStatus, getSetupRun } = await import('../../server/src/services/setup-run-store')
const { setupSweep, setSweepTurnForTests } = await import('../../server/src/services/setup-sweep')
const { controlSetupRun } = await import('../../server/src/services/setup-run-control')
runMigrations()
console.error = () => {}
let failures = 0
const ok = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
async function until(what: string, test: () => boolean): Promise<void> {
  for (const t0 = Date.now(); !test();) {
    if (Date.now() - t0 > 3000) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 5))
  }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const step = (name: string, out: string) => ({ kind: 'http' as const, name, request: { method: 'POST' as const,
  url: 'https://api.example.com/ask', headers: {}, body: '{"a":"{{Answer}}"}', timeout: null },
  mappings: [{ jsonPath: '$.ok', columnName: out }], batchSize: null, runIf: null, autoRun: null })
const config = (out: string) => JSON.stringify({ requestConfig: { method: 'POST', url: 'https://api.example.com/ask',
  headers: {}, body: '{"a":"{{Answer}}"}' }, responseMapping: [{ jsonPath: '$.ok', columnName: out }], previewSize: 0 })

// A sheet of 2 rows, and a setup used on it whose HTTP API steps (one layer, reading Answer) each have a run,
// paused with the setup.
function pausedSetup(steps: number) {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(sid, tid, uid, `S${sid.slice(0, 6)}`, JSON.stringify(['Name', 'Answer']))
  for (const [i, n] of ['ada', 'bob'].entries()) {
    db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
      .run(uuid(), sid, uid, i, JSON.stringify({ Name: n, Answer: `A ${n}` }))
  }
  const spec = { v: 1 as const, inputs: ['Name', 'Answer'], keys: [],
    steps: Array.from({ length: steps }, (_, i) => step(`Ask ${i + 1}`, `Got ${i + 1}`)) }
  const plan = planApply(spec, ['Name', 'Answer'], {}, sheetCandidates(sid, uid))
  if (!('ok' in plan)) throw new Error(JSON.stringify(plan))
  const id = insertSetupRun({ userId: uid, sheetId: sid, setupId: null, setupName: 'Ask',
    plan: { spec: plan.ok.spec, layers: plan.ok.layers, modes: plan.ok.modes }, targetRowIds: null,
    allowSecrets: true, autoRun: false })
  const runs = spec.steps.map((s, i) => {
    const runId = uuid()
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
      VALUES (?,?,?,?,'paused',?)`).run(runId, sid, uid, config(`Got ${i + 1}`), s.name)
    return runId
  })
  saveSteps(id, runs.map(runId => ({ state: 'running' as const, kind: 'http' as const, runId })))
  setStatus(id, 'paused', 'Paused by hand.')
  return { id, sid, runs }
}
const runStatus = (runId: string) => db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(runId)
const generation = (runId: string) =>
  db.prepare('SELECT worker_generation FROM http_runs WHERE id = ?').pluck().get(runId)
const record = (id: string) => db.prepare('SELECT status, access_token_id, error_message FROM setup_runs WHERE id = ?')
  .get(id) as { status: string; access_token_id: string | null; error_message: string | null }

await ok('a sweep while the resume waits on its run\'s job: the run stays pending, its job queued', async () => {
  const { id, runs: [run] } = pausedSetup(1)
  holding = true
  const resuming = controlSetupRun(uid, id, 'resume', true)
  await until('the job\'s insert', () => release !== null)
  holding = false
  assert.equal(runStatus(run), 'pending')
  await setupSweep()
  release!()
  const out = await resuming
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(runStatus(run), 'pending', 'the sweep paused the run the resume had just queued')
  assert.equal(getSetupRun(uid, id)!.status, 'running')
  assert.deepEqual(queued.at(-1), [run, generation(run)], 'its job, at the run\'s generation now')
  await setupSweep()
  assert.equal(runStatus(run), 'pending')
  setStatus(id, 'cancelled')
})

await ok('a pause while the resume waits on its first run\'s job: that run pauses, the second isn\'t resumed',
  async () => {
    const { id, runs: [first, second] } = pausedSetup(2)
    holding = true
    const resuming = controlSetupRun(uid, id, 'resume', true)
    await until('the first job\'s insert', () => release !== null)
    holding = false
    const pause = await controlSetupRun(uid, id, 'pause', true)
    assert.ok('ok' in pause, JSON.stringify(pause))
    release!()
    const out = await resuming
    assert.ok('ok' in out, JSON.stringify(out))
    assert.equal(record(id).status, 'paused')
    assert.deepEqual([runStatus(first), runStatus(second)], ['paused', 'paused'])
    assert.ok(!queued.some(a => a[0] === second), 'the second run was resumed after the pause')
    setStatus(id, 'cancelled')
  })

await ok('a refusal after the first run was resumed: the setup is paused again as it was, the first run too',
  async () => {
    const { id, sid, runs: [first, second] } = pausedSetup(2)
    const before = record(id)
    holding = true
    const resuming = controlSetupRun(uid, id, 'resume', true)
    await until('the first job\'s insert', () => release !== null)
    holding = false
    // Another run takes Answer meanwhile: the second run's resume is refused (its rows would send ⏳).
    const other = uuid()
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
      VALUES (?,?,?,'{}','running','Answer')`).run(other, sid, uid)
    await seedProcessingPlaceholders({ run: { kind: 'http', id: other }, sheetId: sid, userId: uid,
      columns: ['Answer'], targets: null, lastRow: 1, live: () => true })
    release!()
    const out = await resuming
    assert.ok('fail' in out && out.fail === 'conflict', JSON.stringify(out))
    assert.deepEqual(record(id), before)
    assert.deepEqual([runStatus(first), runStatus(second)], ['paused', 'paused'], 'not waiting for a sweep')
    await setupSweep()
    assert.deepEqual([runStatus(first), runStatus(second)], ['paused', 'paused'])
    setStatus(id, 'cancelled')
  })

await ok('a setup resumed during a sweep, after an older setup\'s turn: its run stays pending', async () => {
  const older = pausedSetup(1)
  setStatus(older.id, 'running')
  db.prepare("UPDATE http_runs SET status = 'running' WHERE id = ?").run(older.runs[0])
  db.prepare("UPDATE setup_runs SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(older.id)
  const { id, runs: [run] } = pausedSetup(1)
  setSweepTurnForTests(async turn => {
    if (turn === older.id) assert.ok('ok' in await controlSetupRun(uid, id, 'resume', true))
  })
  try { await setupSweep() } finally { setSweepTurnForTests(null) }
  assert.equal(record(id).status, 'running')
  assert.equal(runStatus(run), 'pending', 'the sweep paused it by the status its list read')
  for (const s of [older.id, id]) setStatus(s, 'cancelled')
})

stand.close()
if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('all passed')
process.exit(0)
