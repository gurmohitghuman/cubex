// The app's AI preview with output columns (routes/ai-preview-parse.ts and
// ai-preview-runner.ts structuredPreview): the request takes output columns
// with the run's own checks, the model is asked for the run's JSON, and each
// answer becomes its typed fields; a reply that isn't that JSON is the row's
// error, and a row that already failed stays as it was.
import parseMod from '../../server/src/routes/ai-preview-parse'
import runnerMod from '../../server/src/routes/ai-preview-runner'
const { parsePreviewRequest } = parseMod as typeof import('../../server/src/routes/ai-preview-parse')
const { structuredPreview } = runnerMod as typeof import('../../server/src/routes/ai-preview-runner')

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const base = { sheetId: 's', columnName: 'Company profile', prompt: 'Describe /company' }
const specs = [
  { columnName: 'Industry', type: 'string', description: 'its industry' },
  { columnName: 'Employees', type: 'number', description: 'headcount' },
  { columnName: 'B2B', type: 'boolean', description: 'sells to businesses' },
]

const plain = parsePreviewRequest(base)
check('without output columns: none', plain.ok && plain.outputColumns === undefined)
const parsed = parsePreviewRequest({ ...base, outputColumns: specs })
check('output columns are taken',
  parsed.ok && parsed.outputColumns?.map(s => s.columnName).join() === 'Industry,Employees,B2B', parsed)
const bad = (outputColumns: unknown) => {
  const r = parsePreviewRequest({ ...base, outputColumns })
  return r.ok ? '' : r.error
}
check('an empty list is refused', /non-empty array/.test(bad([])))
check('an unknown type is refused', /type must be one of/.test(bad([{ columnName: 'A', type: 'date' }])))
check('two names for the same /reference are refused', /same \/column reference/
  .test(bad([{ columnName: 'Fit Score', type: 'string' }, { columnName: 'fit_score', type: 'string' }])))

if (parsed.ok && parsed.outputColumns) {
  const s = structuredPreview(parsed.outputColumns, false)
  check('asks for the run\'s JSON, as raw text', s.args.rawText === true
    && s.args.promptSuffix.includes('"Industry" (string): its industry') && !s.args.promptSuffix.includes('__sources'))
  check('with a web tool it asks for the sources too',
    structuredPreview(parsed.outputColumns, true).args.promptSuffix.includes('__sources'))
  const ok = s.shape({ rowIndex: 3, value: '```json\n{"Industry":"Payments","Employees":"8000","B2B":true}\n```' })
  check('an answer becomes its typed fields', JSON.stringify(ok.fields)
    === '{"Industry":"Payments","Employees":"8000","B2B":"true"}' && !ok.error, ok)
  const notJson = s.shape({ rowIndex: 4, value: 'I could not find it.' })
  check('a reply that is not JSON is the row\'s error', !notJson.fields && /valid JSON/.test(notJson.error ?? ''),
    notJson)
  const failed = s.shape({ rowIndex: 5, value: '', error: 'Failed to generate preview: timeout' })
  check('a failed row stays failed', failed.error === 'Failed to generate preview: timeout' && !failed.fields)
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('ai-preview-structured: all passed')
