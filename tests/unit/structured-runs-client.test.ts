// The sheet menu's rule for which structured AI run (several typed columns from
// one call per row) a column belongs to: client/src/lib/structuredRuns.ts,
// the mirror of server/src/lib/structured-run-owner.ts. Pure, no DB.
import { outputColumnNames, structuredRunColumns, structuredRunOwns } from '../../client/src/lib/structuredRuns'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const specs = JSON.stringify([
  { columnName: 'Keep', type: 'boolean', description: 'd' },
  { columnName: 'Why', type: 'string', description: 'd' },
])
const run = { output_columns: specs, status_column: 'Screen (Status)', data_column: 'Screen (Data)' }

check('typed column names from the spec', JSON.stringify(outputColumnNames(run)) === '["Keep","Why"]')
check('malformed or missing spec → no names', outputColumnNames({ output_columns: '{nope' }).length === 0 && outputColumnNames({}).length === 0)
check('every column it writes: status, typed, (Data)',
  JSON.stringify(structuredRunColumns(run)) === '["Screen (Status)","Keep","Why","Screen (Data)"]')
check('no (Data) column without web tools', !structuredRunColumns({ ...run, data_column: null }).includes('Screen (Data)'))
check('owns its typed, status and (Data) columns', ['Keep', 'Why', 'Screen (Status)', 'Screen (Data)'].every(c => structuredRunOwns(run, c)))
check('exact names only: not a base name or an (Output) sibling',
  !structuredRunOwns(run, 'Screen') && !structuredRunOwns(run, 'Why (Output)') && !structuredRunOwns(run, 'keep'))
check('a deleted status column detaches the run', structuredRunColumns({ ...run, status_column: null }).length === 0)
check('a single-column run owns nothing here', structuredRunColumns({ output_columns: null, status_column: null }).length === 0)

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`)
  process.exit(1)
}
console.log('\nAll structured-runs-client assertions passed.')
