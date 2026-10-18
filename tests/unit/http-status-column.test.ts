// The response code column of an HTTP API column: a response mapping of
// "@status" (lib/http-extract-fields.ts) holds each row's HTTP status code, on
// a failed row too, and "❌ No response" when the API never answered
// (lib/http-cell-values.ts). One per column (lib/http-run-validate.ts).
// Imports open the DB (lib/db.ts): DB_PATH must be a throwaway path.
import fieldsMod from '../../server/src/lib/http-extract-fields'
import cellsMod from '../../server/src/lib/http-cell-values'
import validateMod from '../../server/src/lib/http-run-validate'
import migMod from '../../server/src/db/migrate'
const { extractMappedFields, failedRowFields, statusColumnsOf, isStatusMapping } =
  fieldsMod as typeof import('../../server/src/lib/http-extract-fields')
const { httpResultCellValues } = cellsMod as typeof import('../../server/src/lib/http-cell-values')
const { validateHttpRunColumns } = validateMod as typeof import('../../server/src/lib/http-run-validate')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const mappings = [{ jsonPath: '$.email', columnName: 'Email' }, { jsonPath: '@status', columnName: 'Code' }]

check('@status is the response code mapping', isStatusMapping(mappings[1]) && !isStatusMapping(mappings[0]))
check('its columns', eq(statusColumnsOf(mappings), ['Code']) && eq(statusColumnsOf(undefined), []))
check('extraction puts the code in its column', eq(extractMappedFields({ email: 'a@b.co' }, 201, mappings),
  { Email: 'a@b.co', Code: 201 }))
check('a path that doesn\'t match is null', eq(extractMappedFields({}, 200, mappings), { Email: null, Code: 200 }))
let threw = ''
try { extractMappedFields({ a: [1] }, 200, [{ jsonPath: '$.a[?(@ > 0)]', columnName: 'X' }]) }
catch (e) { threw = (e as Error).message }
check('a path JSONPath refuses still throws, naming the column', threw.includes('(column "X")'), threw)
check('a failed row keeps the code when the API answered', eq(failedRowFields(404, mappings), { Code: 404 }))
check('... and nothing when it never answered', eq(failedRowFields(null, mappings), {}))

const cells = (status: string, extractedFields: Record<string, unknown>, cols = ['Email', 'Code']) =>
  httpResultCellValues({ status, extractedFields, mappingColumns: cols, statusColumns: ['Code'], masterColumn: 'M' })
check('success: the value, the code, ✅', eq(cells('completed', { Email: 'a@b.co', Code: 200 }),
  { Email: 'a@b.co', Code: '200', M: '✅ Success' }))
check('nothing found: ⏭️, yet the code shows', eq(cells('completed', { Email: null, Code: 200 }),
  { Email: '⏭️ No data', Code: '200', M: '⏭️ Skipped' }))
check('failed with an answer: ❌ and the code', eq(cells('failed', { Code: 503 }),
  { Email: '❌ Error', Code: '503', M: '❌ Failed' }))
check('failed with no answer: ❌ No response', eq(cells('failed', {}),
  { Email: '❌ Error', Code: '❌ No response', M: '❌ Failed' }))
check('a column of only the code: ✅ on an answer', eq(cells('completed', { Code: 204 }, ['Code']),
  { Code: '204', M: '✅ Success' }))
check('without a code column nothing changes', eq(httpResultCellValues({
  status: 'completed', extractedFields: { A: '' }, mappingColumns: ['A'], masterColumn: 'M',
}), { A: '⏭️ No data', M: '⏭️ Skipped' }))

const v = (m: Array<{ jsonPath: string; columnName: string }>) => validateHttpRunColumns('s', 'u', m, 'Master', false)
check('@status passes validation', v(mappings).ok)
check('two code columns are refused', /Only one column can hold the response code/.test(v([...mappings,
  { jsonPath: '@status', columnName: 'Code 2' }]).error ?? ''))
check('a near miss is still checked as a JSONPath', !v([{ jsonPath: '@Status', columnName: 'C' }]).ok)
check('the code column can\'t clash with another column name', !v([{ jsonPath: '$.a', columnName: 'Code' },
  { jsonPath: '@status', columnName: 'code' }]).ok)

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nhttp status column: all passed')
