// End-to-end structured-output write test WITHOUT a live model.
//
// The gap this fills: the live round-trip specs (mcp-multi-output*, 
// mcp-preview-idempotency) skip unless CUBEX_SMOKE_OPENROUTER_KEY is set, so the
// automated suite never ran a model response through the real writer. That is
// exactly the path that was corrupting prod. Here we feed REALISTIC completion
// objects (the shape the OpenRouter SDK returns) through the real
// extractCompletionText -> parseMultiOutput -> writeMultiSuccess chain and
// assert on the actual DB cells.
//
// Verified to be a real regression test: with the pre-fix behavior (markdown-
// cleaning the JSON) the first case below fails with "Model did not return
// valid JSON" instead of writing values.
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import ctMod from '../../server/src/lib/completion-text'
import moMod from '../../server/src/lib/ai-multi-output'
import wMod from '../../server/src/services/ai-row-writers-multi'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
runMigrations()
const { extractCompletionText } = ctMod as typeof import('../../server/src/lib/completion-text')
const { parseMultiOutput } = moMod as typeof import('../../server/src/lib/ai-multi-output')
const { writeMultiSuccess, writeMultiFailure } =
  wMod as typeof import('../../server/src/services/ai-row-writers-multi')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const specs = [
  { columnName: 'Score', type: 'number' as const, description: '1-10' },
  { columnName: 'Reason', type: 'string' as const, description: 'why' },
]
const STATUS = 'Lead (Status)'

// One user/table reused; a fresh sheet + run per case.
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')

function freshRun(): { sid: string; rid: string } {
  const sid = uuid(), rid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['val', 'Score', 'Reason', STATUS]))
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,0,?)')
    .run(uuid(), sid, uid, JSON.stringify({ val: 'Stripe', Score: '', Reason: '', [STATUS]: '⏳ Processing...' }))
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,worker_generation,total_rows,processed_rows,output_columns,status_column)
    VALUES (?,?,?,?,?,?, 'running', 0, 1, 0, ?, ?)`)
    .run(rid, sid, uid, STATUS, 'Score /val', 'm', JSON.stringify(specs), STATUS)
  return { sid, rid }
}

// Run one realistic completion through the REAL chain, return the resulting cells.
function runThroughWriter(content: string): Record<string, string> {
  const { sid, rid } = freshRun()
  const completion = { choices: [{ message: { content }, finish_reason: 'stop' }] }
  const ctx = {
    runId: rid, userId: uid, sheetId: sid, rowIndex: 0,
    inputValues: JSON.stringify({ val: 'Stripe' }), statusColumn: STATUS, myGeneration: 0,
  }
  let rawText: string
  try { rawText = extractCompletionText(completion, { cleanMarkdown: false }) }
  catch (e: any) { writeMultiFailure(ctx, specs.map(s => s.columnName), e.message); return cells(sid) }
  const parsed = parseMultiOutput(rawText, specs)
  if ('error' in parsed) writeMultiFailure(ctx, specs.map(s => s.columnName), parsed.error)
  else writeMultiSuccess(ctx, parsed.ok, rawText)
  return cells(sid)
}
function cells(sid: string): Record<string, string> {
  return JSON.parse((db.prepare('SELECT data FROM rows WHERE sheet_id=? AND row_index=0').get(sid) as any).data)
}

// --- the shape that was breaking prod: fenced JSON --------------------------
const fenced = runThroughWriter('```json\n{"Score": 9, "Reason": "Top-tier #1 payments API, sells *developer-first* infra"}\n```')
check('fenced JSON writes the score', fenced.Score === '9')
check('fenced JSON preserves # in the value', fenced.Reason.includes('#1'))
check('fenced JSON preserves * in the value', fenced.Reason.includes('*developer-first*'))
check('fenced JSON marks the row ✅', fenced[STATUS] === '✅')
check('fenced JSON leaves no ⏳', !JSON.stringify(fenced).includes('⏳'))

// --- other shapes real models emit ------------------------------------------
const bare = runThroughWriter('```\n{"Score": 7, "Reason": "solid"}\n```')
check('bare ``` fence writes values', bare.Score === '7' && bare[STATUS] === '✅')

const plain = runThroughWriter('{"Score": 5, "Reason": "ok"}')
check('unfenced JSON still works', plain.Score === '5' && plain[STATUS] === '✅')

const backticks = runThroughWriter('{"Score": 4, "Reason": "run `npm i` first"}')
check('backticks inside a value survive', backticks.Reason === 'run `npm i` first')

// --- genuine failures must STILL fail, not write garbage --------------------
const prose = runThroughWriter('I think the score is about 8, honestly.')
check('non-JSON marks the row ❌', prose[STATUS].startsWith('❌'))
check('non-JSON blanks the output columns', prose.Score === '' && prose.Reason === '')
check('non-JSON leaves no ⏳', !JSON.stringify(prose).includes('⏳'))

// A missing key is a blank cell, not a row failure (deliberate design).
const partial = runThroughWriter('```json\n{"Score": 6}\n```')
check('missing key → blank cell, row still ✅', partial.Score === '6' && partial.Reason === '' && partial[STATUS] === '✅')

console.log(failures === 0 ? '\nAll structured write-path tests passed' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
