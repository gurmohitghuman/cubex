// An AI run's spend limit and its calls cut off before they answered (third
// review), against a stand-in for OpenRouter (ai-spend-kit.ts):
//   - a call cut off after a person paused the run (a structured run too), or
//     after a resume took over, still counts at its most (its row is dropped,
//     its call may be billed: ai_runs.spend_cut_off_micro);
//   - a cut-off call's most that settle() couldn't save stays in the worker's
//     hold, counts for its next row, and close() adds it to the run;
//   - a run paused another way whose spent plus cut-off reach its limit can't
//     resume without a higher one (services/ai-run-floor.ts);
//   - get_run_status and GET /v1/ai-runs/:id name that least
//     (resume_least_usd), for a run with a limit that isn't finished only;
//   - the dialog fills in the least plus the rows left at the average a row
//     cost so far, and the worst case only as finish_usd.
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { endsWithin, OUT, startStandIn, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, runOf, runRow, holds, runById } = w
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { openSpendGate, rowFixedOf } = await import('../../server/src/services/ai-spend-gate')
const { rowMaxMicro } = await import('../../server/src/lib/ai-spend-limit')
const { aiLimitView, resumeAiRun } = await import('../../server/src/services/ai-run-limit')
const { getAiRunSummary } = await import('../../server/src/services/run-status')

// The most one of these rows can cost, in micro-dollars: "Say hi to N0" is 12 bytes.
const mostOf = (runId: string) =>
  rowMaxMicro({ prompt: 0.000001, completion: 0.000001, request: 0 }, rowFixedOf(runById(runId) as never), 12)
const pauseByHand = (runId: string) => () =>
  db.prepare("UPDATE ai_runs SET status = 'paused' WHERE id = ?").run(runId)
const cutOff = (runId: string) =>
  db.prepare('SELECT spend_cut_off_micro FROM ai_runs WHERE id = ?').pluck().get(runId) as number
const held = (runId: string) =>
  db.prepare('SELECT IFNULL(SUM(hold_micro), 0) FROM ai_run_holds WHERE run_id = ?').pluck().get(runId) as number
const spent = (runId: string, usd: number) =>
  db.prepare('UPDATE run_usage SET ai_cost_usd = ? WHERE run_id = ?').run(usd, runId)

// A structured run (one call fills several columns) takes its own row path (services/ai-row-multi.ts).
const STRUCTURED = JSON.stringify([{ columnName: OUT, type: 'string', description: 'A greeting' }])
for (const [how, stop, outputs] of [
  ['a person paused the run', "status = 'paused'", null],
  ['a resume took over', "status = 'pending', worker_generation = worker_generation + 1", null],
  ['a person paused a structured run', "status = 'paused'", STRUCTURED],
] as const) {
  await ok(`a call cut off after ${how} still counts at its most against the limit`, async () => {
    stand.calls = 0
    const { runId } = runOf(3, 1, 1)
    if (outputs) db.prepare('UPDATE ai_runs SET output_columns = ? WHERE id = ?').run(outputs, runId)
    const most = mostOf(runId)
    // While the first call is out the run stops; then its answer breaks off (it may be billed).
    stand.answer = n => {
      if (n === 1) db.prepare(`UPDATE ai_runs SET ${stop} WHERE id = ?`).run(runId)
      return 'cut'
    }
    await endsWithin(processAIRun(runId, 0), 15_000, pauseByHand(runId))
    stand.answer = () => 'ok'
    assert.equal(stand.calls, 1, 'no row started after the stop')
    assert.equal(cutOff(runId), most, "the dropped row's most is the run's cut-off total")
    assert.equal(holds(runId), 0, 'its hold moved there, none is left')
  })
}

await ok("a cut-off call's most settle() couldn't save stays held, counts, and close() adds it to the run",
  async () => {
    const { runId } = runOf(2, 1, 1)
    const most = mostOf(runId)
    // Room for one row at its most and half another.
    db.prepare("UPDATE ai_runs SET status = 'running', spend_limit_usd = ? WHERE id = ?").run(most * 1.5 / 1e6, runId)
    const gate = (await openSpendGate(runById(runId) as never, 0, ['name']))!
    const first = gate.admit({ rowIndex: 0, data: { name: 'N0' } } as never)
    assert.deepEqual(first, { start: most })
    // Another connection holds the write lock past busy_timeout (5 s): the settle's transaction fails.
    const other = new Database(process.env.DB_PATH!)
    other.prepare('BEGIN IMMEDIATE').run()
    try {
      gate.settle(most, { kind: 'failed', message: 'cut off', provider: false, maybeBilled: true })
    } finally {
      other.prepare('COMMIT').run()
      other.close()
    }
    assert.equal(cutOff(runId), 0, 'nothing reached the run')
    assert.equal(held(runId), most, "the worker's hold still keeps it")
    // The next row counts it as cut off: no room is left for that row, so the run would pause.
    const next = gate.admit({ rowIndex: 1, data: { name: 'N1' } } as never)
    assert.ok('pause' in next, JSON.stringify(next))
    assert.match(next.pause, /Calls cut off before their answer came back may still be billed/)
    gate.close()
    assert.equal(cutOff(runId), most, 'close() wrote it to the run')
    assert.equal(holds(runId), 0)
  })

await ok("a run paused another way whose spent and cut-off calls reach its limit can't resume without more",
  async () => {
    const { runId } = runOf(2, 1, 0.01)
    db.prepare("UPDATE ai_runs SET status = 'paused', spend_cut_off_micro = 6000 WHERE id = ?").run(runId)
    spent(runId, 0.004)
    const before = runRow(runId)
    const out = await resumeAiRun(runId, uid, undefined, true)
    assert.ok('fail' in out && out.fail === 'bad_request', JSON.stringify(out))
    assert.equal(out.message, 'The run spent $0.004 of its $0.01 spend limit, calls cut off before they answered '
      + 'may still be billed up to $0.006 (that counts as spent). Resume it with a higher spend_limit_usd, at least '
      + '$0.011, to go on.')
    assert.deepEqual(runRow(runId), before, 'nothing changed')
    assert.deepEqual(await resumeAiRun(runId, uid, 0.010001, true), { ok: true })
  })

await ok('a run summary names the least a resume takes, for a run with a limit that is not finished', async () => {
  const { runId } = runOf(2, 1, 0.01)
  db.prepare("UPDATE ai_runs SET status = 'paused', spend_cut_off_micro = 2000 WHERE id = ?").run(runId)
  spent(runId, 0.003)
  // Paused by hand: what it spent, plus its cut-off calls, plus a micro-dollar.
  assert.equal(getAiRunSummary(runId, uid)!.resume_least_usd, 0.005001)
  // At its limit: also its next row's most, and above the old limit.
  db.prepare(`UPDATE ai_runs SET pause_reason = 'spend_limit', spend_next_row_micro = 4000 WHERE id = ?`).run(runId)
  assert.equal(getAiRunSummary(runId, uid)!.resume_least_usd, 0.010001)
  db.prepare('UPDATE ai_runs SET spend_next_row_micro = 9000 WHERE id = ?').run(runId)
  assert.equal(getAiRunSummary(runId, uid)!.resume_least_usd, 0.014)
  db.prepare("UPDATE ai_runs SET status = 'completed', pause_reason = NULL WHERE id = ?").run(runId)
  assert.equal('resume_least_usd' in getAiRunSummary(runId, uid)!, false, 'a finished run has no resume')
  const { runId: free } = runOf(1, 1, null)
  db.prepare("UPDATE ai_runs SET status = 'paused' WHERE id = ?").run(free)
  const summary = getAiRunSummary(free, uid)!
  assert.equal('resume_least_usd' in summary || 'spend_limit_usd' in summary, false, 'a run without a limit')
})

await ok('the dialog fills in the least plus the rows left at the average row cost; the worst case is words only',
  async () => {
    const { runId } = runOf(14, 1, 0.1)
    db.prepare(`UPDATE ai_runs SET status = 'paused', pause_reason = 'spend_limit', processed_rows = 4,
      spend_next_row_micro = 120000 WHERE id = ?`).run(runId)
    spent(runId, 0.04)
    const v = aiLimitView(runId, uid)!
    // The least: $0.04 spent plus the next row's $0.12 most. Then 10 rows left at the $0.01 a row cost.
    assert.deepEqual([v.least_usd, v.avg_row_usd, v.rows_left, v.suggest_usd], [0.16, 0.01, 10, 0.26])
    // Enough to finish for sure, every row left at its most: shown, never filled in.
    assert.equal(v.finish_usd, 1.24)
    // Before any row ran there is nothing to go by: the least, rounded up as the refusal prints it.
    db.prepare(`UPDATE ai_runs SET processed_rows = 0, spend_next_row_micro = 4805 WHERE id = ?`).run(runId)
    spent(runId, 0)
    const fresh = aiLimitView(runId, uid)!
    assert.deepEqual([fresh.least_usd, fresh.avg_row_usd, fresh.suggest_usd], [0.100001, null, 0.11])
    db.prepare('UPDATE ai_runs SET spend_limit_usd = 0.000001 WHERE id = ?').run(runId)
    const tiny = aiLimitView(runId, uid)!
    assert.deepEqual([tiny.least_usd, tiny.suggest_usd, tiny.finish_usd], [0.004805, 0.0049, 0.068])
  })

stand.close()
w.done()
