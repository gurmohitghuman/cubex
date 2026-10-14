// Writing a formula with AI (services/formula-ai.ts, lib/formula-prompt.ts),
// with the model call replaced by scripted replies: what the model is shown
// (JSON columns as a trimmed shape, status words left out), how a reply is
// read, and the tries: a reply that doesn't compile, or errors on every
// sample row, is told back once; CANNOT and a dead model end it.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import promptMod from '../../server/src/lib/formula-prompt'
import aiMod from '../../server/src/services/formula-ai'
import markMod from '../../server/src/lib/run-markers'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { formulaSamples, formulaUserMessage, readFormulaReply } =
  promptMod as typeof import('../../server/src/lib/formula-prompt')
const { formulaAttempts } = aiMod as typeof import('../../server/src/services/formula-ai')
const { holdsRunMarker } = markMod as typeof import('../../server/src/lib/run-markers')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

// --- reading a reply ---------------------------------------------------------
check('fences and a label are stripped', JSON.stringify(readFormulaReply('```js\nformula: {{A}} + 1\n```'))
  === JSON.stringify({ formula: '{{A}} + 1' }))
check('CANNOT is a refusal', 'cannot' in readFormulaReply('CANNOT: no column has prices')
  && (readFormulaReply('CANNOT: no column has prices') as { cannot: string }).cannot === 'no column has prices')
check('a multi-line formula stays whole', (readFormulaReply('(() => {\n  return 1;\n})()') as { formula: string })
  .formula.split('\n').length === 3)

// --- what the model is shown ---------------------------------------------------
const many = Array.from({ length: 30 }, (_, k) => ({ type: k ? 'personal' : 'work', value: `p${k}@x.com` }))
const rows = [
  { Response: JSON.stringify({ emails: many, name: 'A'.repeat(100) }), Name: 'Ada' },
  { Response: '⏳ Processing...', Name: 'Ada' },
  { Name: '❌ Error' },
  { Name: 'Grace' },
]
const samples = formulaSamples(['Response', 'Name', 'Empty'], rows, holdsRunMarker)
const shape = 'json' in samples.Response ? samples.Response.json : ''
check('a JSON column is shown as its shape', shape.includes('"emails":[{"type":"work"') && shape.includes('28 more')
  && shape.includes('AAAA…') && shape.length <= 1501, shape)
check('text columns: distinct values, status words left out', JSON.stringify(samples.Name)
  === JSON.stringify({ values: ['Ada', 'Grace'] }), samples.Name)
const msg = formulaUserMessage('the work email', samples, 'SyntaxError: x')
check('the message names JSON columns and empty ones, and the refusal', msg.includes('{{Response}} (JSON')
  && msg.includes('{{Empty}}: (empty in the rows shown)') && msg.includes("didn't work: SyntaxError: x"), msg)

// --- the tries ---------------------------------------------------------------
const uid = uuid(), tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sheetId, tableId, uid, 'S', JSON.stringify(['Response', 'Name']))
rows.forEach((data, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  .run(uuid(), sheetId, uid, i, JSON.stringify(data)))

function scripted(replies: Array<string | Error>) {
  const asked: string[] = []
  const ask = async (user: string) => {
    asked.push(user)
    const r = replies.shift()!
    if (r instanceof Error) throw r
    return { text: r, cost: 0.0001 }
  }
  return { ask, asked }
}
const message = (retry?: string) => `ask${retry ? ` | refused: ${retry}` : ''}`

async function main() {
  {
    const s = scripted(['{{Response}}?.emails?.find(e => e.type == "work")?.value +* 1',
      '{{response}}?.emails?.find(e => e.type == "work")?.value ?? ""'])
    const out = await formulaAttempts(uid, sheetId, s.ask, message)
    check('a reply that does not compile is told back, and the second one is kept', 'ok' in out
      && out.ok.formula.startsWith('{{Response}}?.emails') && out.ok.preview.samples[0].result === 'p0@x.com'
      && /refused: SyntaxError/.test(s.asked[1]) && Math.abs((out.ok.cost_usd ?? 0) - 0.0002) < 1e-9, { out, s })
  }
  {
    const s = scripted(['{{Response}}.nope.value', '{{Name}}.toUpperCase()'])
    const out = await formulaAttempts(uid, sheetId, s.ask, message)
    check('errors on every sample row are told back', 'ok' in out && out.ok.formula === '{{Name}}.toUpperCase()'
      && /error on every sample row/.test(s.asked[1]), { out, s })
  }
  {
    const s = scripted(['{{Nope}}', '{{Nope2}}'])
    const out = await formulaAttempts(uid, sheetId, s.ask, message)
    check('two bad replies end with why',
      'fail' in out && /didn't work: There's no column named "Nope2"/.test(out.message), out)
  }
  {
    const out = await formulaAttempts(uid, sheetId, scripted(['CANNOT: needs a judgment']).ask, message)
    check('CANNOT ends it at once',
      'fail' in out && /couldn't write that as a formula: needs a judgment/.test(out.message))
  }
  {
    const out = await formulaAttempts(uid, sheetId, scripted([new Error('429 rate limited')]).ask, message)
    check('a model that does not answer is upstream', 'upstream' in out && /429/.test(out.upstream))
  }
}

main().then(() => {
  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nAll formula AI assertions passed.')
  process.exit(0)
}).catch(e => { console.error(e); process.exit(1) })
