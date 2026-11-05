// An AI prompt reads a listed column the row holds no value for as an empty
// cell, not "[MISSING: /col]" (lib/prompt.ts processPromptTemplate, given the
// sheet's column_order): rows from before a column was added (Add Column, a
// webhook field) have no key for it. A name that is no column still gives
// [MISSING], and a row holding its keys gets the same prompt and draft
// fingerprint as before, byte for byte. Checked on the pure function, the draft
// fingerprint, a real AI run (prose and structured), a preview row, credit
// reuse at run start and an estimate.
import { createHash } from 'node:crypto'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

// No network: OpenRouter's model list is unavailable (a run and an estimate go on without it).
globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { encrypt } = await import('../../server/src/lib/crypto')
const { processPromptTemplate } = await import('../../server/src/lib/prompt')
const { computeInputHash, saveDraftPreview, upsertDraftConfig } = await import('../../server/src/lib/ai-drafts')
const { promotePreviewReuse } = await import('../../server/src/lib/ai-run-promote')
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { getOpenRouterClient } = await import('../../server/src/services/openrouter')
const { processOneRow } = await import('../../server/src/routes/ai-preview-runner')
const { estimateAiRun } = await import('../../server/src/services/run-estimate')
const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
runMigrations()

// --- The pure substitution ------------------------------------------------------
const cols = ['Name', 'Company Name', 'Mail', 'constructor']
const prompt = 'Hi /name at /company_name: /mail /constructor ($& kept) /nope'
const full = { Name: 'Ann', 'Company Name': 'Acme', Mail: 'a@x.io', constructor: 'c' }
const filled = 'Hi Ann at Acme: a@x.io c ($& kept) [MISSING: /nope]'
check('a row holding every key: the same prompt as before, with or without the column list',
  processPromptTemplate(prompt, full, cols) === filled && processPromptTemplate(prompt, full, []) === filled,
  processPromptTemplate(prompt, full, cols))
// JSON.parse output, as rows.data is read: no own "Mail" or "constructor" key.
const older = JSON.parse('{"Name":"Bob","Company Name":"Bee"}') as Record<string, string>
const emptyCells = { ...older, Mail: '', constructor: '' }
const olderFilled = processPromptTemplate(prompt, older, cols)
check('a listed column the row has no key for reads as empty (also "constructor"), not [MISSING]',
  olderFilled === 'Hi Bob at Bee:   ($& kept) [MISSING: /nope]', olderFilled)
check('... the same prompt as a row holding empty cells there',
  olderFilled === processPromptTemplate(prompt, emptyCells, cols))
check('a name that is no column of the sheet still gives [MISSING]',
  processPromptTemplate('/nope and /mail', {}, cols) === '[MISSING: /nope] and ')

// --- The draft fingerprint (the preview's input hash, checked at run start) -----
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
check('the fingerprint of a row holding its keys is unchanged', computeInputHash(prompt, full, cols) === sha(filled)
  && computeInputHash(prompt, full, cols) === computeInputHash(prompt, full, []))
check('a row without the key fingerprints like one with an empty cell (a preview of it can be reused)',
  computeInputHash(prompt, older, cols) === computeInputHash(prompt, emptyCells, cols))

// --- A real run, a preview row and an estimate -----------------------------------
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?, ?, ?)')
  .run(uuid(), uid, encrypt('sk-or-test'))
function sheetOf(columns: string[], rows: Array<Record<string, string>>): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
    .run(sid, tid, uid, `S-${sid.slice(0, 8)}`, JSON.stringify(columns))
  rows.forEach((r, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), sid, uid, i, JSON.stringify(r)))
  return sid
}

// OpenRouter's chat call, replaced on the SDK: the prompt each row sent.
const sent: string[] = []
let answer = 'ok'
const client = await getOpenRouterClient(uid)
Object.getPrototypeOf(client.chat.completions).create = async (body: { messages: Array<{ content: string }> }) => {
  sent.push(body.messages.at(-1)!.content)
  return {
    id: `c${sent.length}`, usage: { prompt_tokens: 5, completion_tokens: 1 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }],
  }
}
const sentFor = (name: string) => sent.filter(p => p.includes(name))

// Bob's row is from before "Mail" was added: it has no key for it.
const runSheet = sheetOf(['Name', 'Mail', 'Hi (Output)'], [
  { Name: 'Ann', Mail: 'a@x.io', 'Hi (Output)': PLACEHOLDER },
  { Name: 'Bob', 'Hi (Output)': PLACEHOLDER },
])
const run = uuid()
db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, concurrency, status, total_rows)
  VALUES (?, ?, ?, 'Hi (Output)', 'Write to /name at /mail.', 'test/model', 1, 'pending', 2)`).run(run, runSheet, uid)
await processAIRun(run, 0)
check('a run: a row holding the key sends its value, as before', sentFor('Ann')[0] === 'Write to Ann at a@x.io.', sent)
check('... a row without it sends an empty value, not [MISSING]', sentFor('Bob')[0] === 'Write to Bob at .', sent)
check('... and both rows are written', (db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$."Hi (Output)"') = 'ok'`).pluck().get(runSheet) as number) === 2)

// A structured run (output columns) builds its prompt the same way.
sent.length = 0
answer = '{"Score": 7}'
const multiSheet = sheetOf(['Name', 'Mail', 'Score', 'Lead (Status)'], [
  { Name: 'Cat', Score: '', 'Lead (Status)': PLACEHOLDER },
])
const multi = uuid()
db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, concurrency, status, total_rows,
    output_columns, status_column)
  VALUES (?, ?, ?, 'Lead (Status)', 'Score /name by /mail.', 'test/model', 1, 'pending', 1, ?, 'Lead (Status)')`)
  .run(multi, multiSheet, uid, JSON.stringify([{ columnName: 'Score', type: 'number', description: '1-10' }]))
await processAIRun(multi, 0)
check('a structured run: a row without the key sends an empty value', sent.length === 1
  && sent[0].startsWith('Score Cat by .\n\n') && !sent[0].includes('[MISSING'), sent)

// A preview row (the AI column dialog's preview and preview_rows both run it).
sent.length = 0
answer = 'ok'
await processOneRow({ rowIndex: 1, data: { Name: 'Bob' } }, client, {
  prompt: 'Write to /name at /mail.', columns: ['Name', 'Mail'], model: 'test/model', safeTemperature: 0.7,
  search: null, useWebFetch: false,
})
check('a preview row without the key sends an empty value', sent[0] === 'Write to Bob at .', sent)

// Credit reuse: a preview row's fingerprint is the prompt it sent; run start
// promotes the row only while the row's prompt still fingerprints the same.
const reuseRows = [{ Name: 'Ann', Mail: 'a@x.io' }, { Name: 'Bob' }]
const reuseSheet = sheetOf(['Name', 'Mail', 'Hi (Output)'], reuseRows)
const config = { columnName: 'Hi', prompt: 'Write to /name at /mail.', systemPrompt: null, model: 'test/model',
  temperature: 0.7, useOpenRouterWebSearch: false, useWebFetch: false, maxChars: null, concurrency: 1 }
const previewed = []
for (const [i, data] of reuseRows.entries()) {
  sent.length = 0
  await processOneRow({ rowIndex: i, data }, client, { ...config, columns: ['Name', 'Mail', 'Hi (Output)'],
    systemPrompt: undefined, safeTemperature: 0.7, search: null })
  previewed.push({ rowIndex: i, value: `v${i}`, inputHash: sha(sent[0]) })
}
saveDraftPreview(uid, reuseSheet, upsertDraftConfig(uid, reuseSheet, config, 0), previewed, 2)
const reuseRun = uuid()
db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, total_rows)
  VALUES (?, ?, ?, 'Hi (Output)', ?, 'test/model', 'pending', 2)`).run(reuseRun, reuseSheet, uid, config.prompt)
const promoted = db.transaction(() => promotePreviewReuse({ runId: reuseRun, userId: uid, sheetId: reuseSheet,
  runConfig: config, outputColumn: 'Hi (Output)', targets: null })).immediate()
check('run start reuses both previewed rows: the one holding the key and the one without it',
  JSON.stringify(promoted) === '[0,1]', promoted)

// An estimate prices the prompt as the run would send it.
const estimateOf = async (rows: Array<Record<string, string>>) => {
  const out = await estimateAiRun(uid, {
    sheetId: sheetOf(['Name', 'Mail'], rows), prompt: `Write to /name at /mail. ${'x'.repeat(40)}`,
    model: 'test/model', maxChars: null, concurrency: 1,
  })
  return 'ok' in out ? out.ok.assumptions.avg_input_tokens : out
}
const lacking = await estimateOf([{ Name: 'Dee' }])
const holding = await estimateOf([{ Name: 'Dee', Mail: '' }])
check('an estimate prices a row without the key like one with an empty cell', typeof lacking === 'number'
  && lacking === holding, { lacking, holding })

console.log(failures === 0 ? '\nprompt listed columns: all passed' : `\nprompt listed columns: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
