// The sample table against a migrated throwaway DB (services/sample-table.ts):
// 25 made-up rows at .example addresses, the clean and formula columns filled,
// the AI column empty with no run and a saved draft (name and prompt, never a
// model, even when the account has a default), every column described, the
// duplicate found by a dry run, one History line that marks it as the sample, a
// free name each time, into the trash like any table, and sheet caps too low
// for it refused up front with the cap named.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import sampleMod from '../../server/src/services/sample-table'
import answerMod from '../../server/src/services/sample-answer'
import tableMod from '../../server/src/services/table-crud'
import draftMod from '../../server/src/lib/ai-drafts'
import promptMod from '../../server/src/lib/prompt'
import setupMod from '../../server/src/lib/sample/setup'
import leadsMod from '../../server/src/lib/sample/leads'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { createSampleTable, isSampleSheet, sampleCapProblem } =
  sampleMod as typeof import('../../server/src/services/sample-table')
const { sampleAnswer } = answerMod as typeof import('../../server/src/services/sample-answer')
const { createTable, deleteTable } = tableMod as typeof import('../../server/src/services/table-crud')
const { getDraft } = draftMod as typeof import('../../server/src/lib/ai-drafts')
const { findUnknownColumnReferences } = promptMod as typeof import('../../server/src/lib/prompt')
const { SAMPLE_AI_COLUMN, SAMPLE_AI_PROMPT, SAMPLE_COLUMN_DESCRIPTIONS } =
  setupMod as typeof import('../../server/src/lib/sample/setup')
const { SAMPLE_ROWS } = leadsMod as typeof import('../../server/src/lib/sample/leads')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const cells = (sheetId: string, column: string): string[] => db.prepare(`SELECT json_extract(data, ?) FROM rows
  WHERE sheet_id = ? ORDER BY row_index`).pluck().all(`$."${column}"`, sheetId) as string[]

async function main() {
  // The data itself: invented, at .example, messy on purpose.
  check('25 rows', SAMPLE_ROWS.length === 25)
  const addresses = SAMPLE_ROWS.flatMap(r => [r.Website, r.Email]).filter(v => v.trim())
  check('every website and email ends at .example',
    addresses.every(v => /\.example(\/[^\s]*)?$/i.test(v.trim())), addresses.filter(v => !/\.example/i.test(v)))
  check('one lead has no email', SAMPLE_ROWS.filter(r => !r.Email.trim()).length === 1)
  check('some values carry extra spaces', SAMPLE_ROWS.some(r => r.Name !== r.Name.trim()))

  // Caps too low for the sample: refused before anything is made, naming the cap.
  check('the default caps fit the sample', sampleCapProblem() === null)
  const fewColumns = sampleCapProblem(4, 1_000)
  check('too few columns: named', /needs 8 columns.*allows 4.*MAX_COLUMNS_PER_SHEET/.test(fewColumns ?? ''), fewColumns)
  const fewRows = sampleCapProblem(200, 10)
  check('too few rows: named', /needs 25 rows.*allows 10.*MAX_ROWS_PER_SHEET/.test(fewRows ?? ''), fewRows)
  check('exactly enough fits', sampleCapProblem(8, 25) === null)

  const made = await createSampleTable(uid)
  if (!('ok' in made)) throw new Error(JSON.stringify(made))
  const s = made.ok
  check('named "Sample leads", sheet "Leads"', s.tableName === 'Sample leads' && s.sheetName === 'Leads', s)
  check('no problems', s.problems.length === 0, s.problems)
  const order = JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(s.sheetId) as string)
  check('each column beside what it reads, the website last', JSON.stringify(order) === JSON.stringify(
    ['Name', 'Company', 'Company (clean)', 'Title', 'Seniority', SAMPLE_AI_COLUMN, 'Email', 'Website']), order)
  check('25 rows in the sheet', cells(s.sheetId, 'Name').length === 25)

  const clean = cells(s.sheetId, 'Company (clean)')
  check('Company (clean) filled', clean[1] === 'Harborline Freight' && clean[4] === 'Lumen Dental Group', clean)
  const seniority = cells(s.sheetId, 'Seniority')
  check('Seniority filled', seniority[0] === 'Leader' && seniority[2] === 'Manager' && seniority[9] === 'Individual'
    && seniority[19] === 'Individual',
    seniority)
  check('filled lists both', JSON.stringify(s.filled) === JSON.stringify(['Company (clean)', 'Seniority']), s.filled)

  check('the AI column is empty', cells(s.sheetId, SAMPLE_AI_COLUMN).every(v => v === null))
  const runs = db.prepare(`SELECT (SELECT COUNT(*) FROM ai_runs WHERE sheet_id = ?)
    + (SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?)`).pluck().get(s.sheetId, s.sheetId)
  check('no run of any kind', runs === 0, runs)
  check('its prompt reads real columns', findUnknownColumnReferences(SAMPLE_AI_PROMPT, order).length === 0)
  const draft = getDraft(uid, s.sheetId)
  check('the AI drawer draft: name and prompt, no model', draft?.config.columnName === 'Good fit'
    && draft.config.prompt === SAMPLE_AI_PROMPT && draft.config.model === '' && draft.previewResults === null, draft)

  const described = db.prepare('SELECT column_name FROM column_descriptions WHERE sheet_id = ?').pluck()
    .all(s.sheetId) as string[]
  check('every column described', order.every((c: string) => described.includes(c) && SAMPLE_COLUMN_DESCRIPTIONS[c]),
    described)
  const sheetWords = db.prepare('SELECT description FROM sheets WHERE id = ?').pluck().get(s.sheetId) as string
  check('the sheet says it is made up', /made-up/.test(sheetWords), sheetWords)

  const d = s.duplicates
  check('the duplicate: row 18 repeats row 3', d?.duplicateRows === 1 && d.samples[0]?.kept.row === 3
    && d.samples[0]?.removed[0]?.row === 18 && d.emptyKeyRows === 1, d)
  check('nothing removed by the check', cells(s.sheetId, 'Name').length === 25)

  const log = db.prepare('SELECT action FROM sheet_changes WHERE sheet_id = ? ORDER BY id').pluck()
    .all(s.sheetId) as string[]
  check('History: one line, the sample', JSON.stringify(log) === JSON.stringify(['sample_created']), log)
  check('isSampleSheet: the sample', isSampleSheet(s.sheetId, uid))
  const plain = createTable(uid, 'Plain')
  check('isSampleSheet: not a plain sheet', 'ok' in plain && !isSampleSheet(plain.ok.sheetId, uid))

  const answer = sampleAnswer(s, 'mcp')
  check('the agent answer: not run, 5 row ids, says fictional', answer.ai_column.ran === false
    && answer.ai_column.target_row_ids.length === 5 && /made up/.test(answer.fictional)
    && answer.duplicates?.groups[0]?.kept_row === 3, answer)

  // A second one, with an account default model: a free name, the model in the draft.
  db.prepare("INSERT INTO settings (id, user_id, default_ai_model) VALUES (?, ?, 'some/model')").run(uuid(), uid)
  const again = await createSampleTable(uid)
  if (!('ok' in again)) throw new Error(JSON.stringify(again))
  check('a second one is "Sample leads 2"', again.ok.tableName === 'Sample leads 2', again.ok.tableName)
  check('its draft still holds no model (the drawer takes the default live); the answer names it',
    getDraft(uid, again.ok.sheetId)?.config.model === '' && again.ok.ai.model === 'some/model')

  // Like any table: into the trash, its name free again.
  const gone = deleteTable(uid, s.tableId)
  check('deleting puts it in the trash', 'ok' in gone && gone.ok.trashId !== null, gone)
  const third = await createSampleTable(uid)
  check('the name is free again', 'ok' in third && third.ok.tableName === 'Sample leads', third)
}

main().then(() => {
  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nAll sample table assertions passed.')
  process.exit(0)
}).catch(e => { console.error(e); process.exit(1) })
