// A run's model is checked against OpenRouter's model list when it starts and
// is resumed, and when a default model is saved (lib/ai-model-check.ts): a
// model the list doesn't have is refused; routing variants (:nitro, :floor,
// :exacto, :online) follow any listed id, presets pass; a :batch variant is
// never listed (routing variants after it or a preset don't change that) and
// is refused even without the list, naming the id to use; without the list
// (down, empty, or slower than MODEL_CHECK_WAIT_MS) nothing else is refused,
// and a slow read isn't waited on twice. OpenRouter is a stand-in on 127.0.0.1.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

type Mode = 'ok' | 'down' | 'slow' | 'empty'
let mode: Mode = 'empty'
const LISTED = ['openai/gpt-4o-mini', 'meta/llama-4:free', 'openai/gpt-4o-mini:batch', 'openrouter/auto']
const server = http.createServer((req, res) => {
  req.resume()
  const answer = () => {
    if (mode === 'down' || mode === 'slow') {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: (mode === 'empty' ? [] : LISTED).map(id => ({ id, name: id, pricing: { prompt: '0', completion: '0' } })) }))
  }
  if (mode === 'slow') setTimeout(answer, 4000)
  else answer()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { modelListed, checkModel, modelProblem, modelGone, batchOnlyRefusal, runnableModels } =
  await import('../../server/src/lib/ai-model-check')
const { MODEL_CHECK_WAIT_MS } = await import('../../server/src/lib/constants')
const { setAccountDefaultModel, setSheetDefaultModel } = await import('../../server/src/services/ai-model-config')
const { startAiRun } = await import('../../server/src/services/ai-run-start')
const { resumeRun } = await import('../../server/src/services/run-lifecycle')
// The list is cached 5 minutes: moving the clock on reads it again.
const realNow = Date.now
let shiftMs = 0
Date.now = () => realNow() + shiftMs
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare(`INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)`)
  .run(sid, tid, uid, 'S', JSON.stringify(['name']))

async function main() {
  // Pure: the id rules.
  const ids = new Set(LISTED)
  const listed = (m: string) => modelListed(m, ids)
  check('a listed id', listed('openai/gpt-4o-mini'))
  check('routing variants follow any listed id, several of them',
    listed('openai/gpt-4o-mini:nitro') && listed('openai/gpt-4o-mini:floor:exacto') && listed('openrouter/auto:online'))
  check('a listed catalog variant, with routing variants after it',
    listed('meta/llama-4:free') && listed('meta/llama-4:free:nitro'))
  check('a :batch variant is never listed, though the list has it; routing variants or a preset after it neither',
    !listed('openai/gpt-4o-mini:batch') && !listed('openai/gpt-4o-mini:batch:nitro')
    && !listed('openai/gpt-4o-mini:batch:floor:online') && !listed('openai/gpt-4o-mini:batch@preset/email-writer')
    && !listed('openai/gpt-4o-mini:batch:thinking'))
  const batchWords = (id: string, use: string) => `The model "${id}" is a batch-only variant: it runs only through `
    + `OpenRouter's batch API, which Cubex doesn't use. Use "${use}" instead.`
  const refusals = [
    batchOnlyRefusal('openai/gpt-4o-mini:batch'), batchOnlyRefusal(' openai/gpt-4o-mini:batch:nitro '),
    batchOnlyRefusal('openai/gpt-4o-mini:batch@preset/email-writer'),
    batchOnlyRefusal('openai/gpt-4o-mini:batch:thinking:nitro'),
  ]
  check('a :batch refusal names the id without :batch, routing variants and preset kept', JSON.stringify(refusals)
    === JSON.stringify([batchWords('openai/gpt-4o-mini:batch', 'openai/gpt-4o-mini'),
      batchWords('openai/gpt-4o-mini:batch:nitro', 'openai/gpt-4o-mini:nitro'),
      batchWords('openai/gpt-4o-mini:batch@preset/email-writer', 'openai/gpt-4o-mini@preset/email-writer'),
      batchWords('openai/gpt-4o-mini:batch:thinking:nitro', 'openai/gpt-4o-mini:thinking:nitro')]), refusals)
  check('only a :batch variant is refused that way',
    [batchOnlyRefusal('openai/gpt-4o-mini'), batchOnlyRefusal('meta/llama-4:free:nitro'),
      batchOnlyRefusal('@preset/batch'), batchOnlyRefusal('batch'), batchOnlyRefusal(':batch'),
      batchOnlyRefusal('openai/gpt-4o-mini:batched')].every(r => r === null))
  check('without a list, a :batch variant is still refused and nothing else is',
    modelGone(null, 'openai/gpt-4o-mini:batch:nitro', 'Fix.') === batchWords('openai/gpt-4o-mini:batch:nitro',
      'openai/gpt-4o-mini:nitro') && modelGone(null, 'nobody/none', 'Fix.') === null)
  check('a model the list lacks gets the fix after its refusal; a :batch one gets the batch words alone',
    modelGone(ids, 'openai/gpt-4o-mni', 'Fix.')?.endsWith('mistyped. Fix.') === true
    && modelGone(ids, 'openai/gpt-4o-mini:batch', 'Fix.')
      === batchWords('openai/gpt-4o-mini:batch', 'openai/gpt-4o-mini'))
  check('runnableModels leaves out the :batch entries only', JSON.stringify(runnableModels(LISTED.map(id => ({ id }))))
    === JSON.stringify(['openai/gpt-4o-mini', 'meta/llama-4:free', 'openrouter/auto'].map(id => ({ id }))))
  check('a deprecated catalog variant of a listed model is accepted', listed('openai/gpt-4o-mini:thinking'))
  check('a catalog variant the list lacks is not', !listed('openai/gpt-4o-mini:free'))
  check('a mistyped id, an unknown variant and a bare variant are not',
    !listed('openai/gpt-4o-mni') && !listed('openai/gpt-4o-mini:fast') && !listed(':nitro'))
  check('surrounding spaces are ignored', listed('  openai/gpt-4o-mini '))
  check('a preset passes; a model with a preset is checked by its model',
    listed('@preset/email-writer') && listed('openai/gpt-4o-mini@preset/email-writer')
    && !listed('openai/gpt-4o-mni@preset/email-writer') && !listed('@typo'))

  // An empty list (a proxy answering for OpenRouter) can't refuse anything.
  check('list empty: unchecked', await checkModel('nobody/none') === 'unchecked')
  shiftMs += 6 * 60_000
  mode = 'down'

  // Without the list nothing is refused, and a default saved then says it wasn't checked.
  check('list down: unchecked', await checkModel('nobody/none') === 'unchecked')
  const savedBlind = await setAccountDefaultModel(uid, 'nobody/none')
  check('list down: a default is saved, marked unchecked',
    'ok' in savedBlind && savedBlind.ok.model === 'nobody/none' && savedBlind.ok.checked === false, savedBlind)
  mode = 'slow'
  const t0 = Date.now()
  const slow = await checkModel('nobody/none')
  const waited = Date.now() - t0
  check('list slower than the wait: unchecked, after about the wait',
    slow === 'unchecked' && waited >= MODEL_CHECK_WAIT_MS - 50 && waited < MODEL_CHECK_WAIT_MS + 1500, { slow, waited })
  const t1 = Date.now()
  const again = await checkModel('nobody/none')
  check('a read already past the wait isn\'t waited on again', again === 'unchecked' && Date.now() - t1 < 200,
    { again, ms: Date.now() - t1 })
  await new Promise(resolve => setTimeout(resolve, 4000 - waited + 300)) // the slow answer lands (a failure)

  // With the list.
  mode = 'ok'
  check('a listed model passes', await checkModel('openai/gpt-4o-mini:nitro') === 'listed')
  const problem = await modelProblem('openai/gpt-4o-mni')
  check('a model the list lacks is refused, named', !!problem && problem.includes('"openai/gpt-4o-mni"'), problem)

  const gone = await setAccountDefaultModel(uid, 'openai/gpt-4o-mni')
  check('a default the list lacks is refused, and nothing is saved',
    'fail' in gone && gone.fail === 'bad_request' && gone.gone === true
    && db.prepare('SELECT default_ai_model FROM settings WHERE user_id = ?').pluck().get(uid) === 'nobody/none', gone)
  const good = await setSheetDefaultModel(uid, sid, 'openai/gpt-4o-mini')
  check('a listed sheet default is saved, checked', 'ok' in good && good.ok.checked === true, good)
  const cleared = await setAccountDefaultModel(uid, null)
  check('clearing a default needs no list', 'ok' in cleared && cleared.ok.model === null && cleared.ok.checked, cleared)
  const missing = await setSheetDefaultModel(uid, uuid(), 'openai/gpt-4o-mni')
  check('a sheet that isn\'t there is not found before the model is looked at',
    'fail' in missing && missing.fail === 'not_found', missing)

  const run = await startAiRun(uid, {
    sheetId: sid, model: 'openai/gpt-4o-mni', prompt: 'Hi /name', cleanColumnName: 'Hi',
  } as Parameters<typeof startAiRun>[1])
  const paused = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status)
    VALUES (?,?,?,?,?,?,'paused')`).run(paused, sid, uid, 'Hi (Output)', 'Hi /name', 'openai/gpt-4o-mni')
  const resumed = await resumeRun('ai', paused, uid, true)
  check('resuming a run whose model is gone is refused, and it stays paused',
    'fail' in resumed && resumed.fail === 'model_gone' && /Edit the column/.test(resumed.message)
    && db.prepare('SELECT status FROM ai_runs WHERE id = ?').pluck().get(paused) === 'paused', resumed)

  check('a run on a model the list lacks is refused before it starts',
    'fail' in run && run.fail === 'bad_request' && /doesn't offer the model/.test(run.message)
    && db.prepare("SELECT count(*) FROM ai_runs WHERE status <> 'paused'").pluck().get() === 0, run)
}

main()
  .catch(err => { failures++; console.log('FAIL threw', err) })
  .finally(() => {
    server.close()
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    process.exit(0)
  })
