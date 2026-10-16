// The setup runner against a migrated throwaway DB (services/setup-runner.ts):
// a chain of two clean columns used on a sheet. A step waits while a reader
// holds the sheet (an export) instead of failing the setup, starts once it's
// free, and the second step starts only after the first one's fill is done;
// the record ends done with both columns filled. Stopping a setup starts
// nothing more.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import busyMod from '../../server/src/lib/sheet-busy'
import planMod from '../../server/src/lib/setups/apply-plan'
import libMod from '../../server/src/services/setup-library'
import storeMod from '../../server/src/services/setup-run-store'
import runnerMod from '../../server/src/services/setup-runner'
import controlMod from '../../server/src/services/setup-run-control'
import type { SetupSpec } from '../../server/src/lib/setups/spec'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { withSheetRead } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { planApply } = planMod as typeof import('../../server/src/lib/setups/apply-plan')
const { insertSetup } = libMod as typeof import('../../server/src/services/setup-library')
const { insertSetupRun, getSetupRun } = storeMod as typeof import('../../server/src/services/setup-run-store')
const { advanceSetupRun } = runnerMod as typeof import('../../server/src/services/setup-runner')
const { controlSetupRun } = controlMod as typeof import('../../server/src/services/setup-run-control')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), tableId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
function sheet(names: string[]): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(id, tableId, uid, `S${id.slice(0, 6)}`, JSON.stringify(['Name']))
  names.forEach((n, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(uuid(), id, uid, i, JSON.stringify({ Name: n })))
  return id
}
const cells = (sheetId: string, col: string) =>
  (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sheetId) as string[])
    .map(d => JSON.parse(d)[col] ?? '')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const spec: SetupSpec = { v: 1, inputs: ['Name'], keys: [], steps: [
  { kind: 'clean', name: 'Trimmed', source: 'Name', cleaner: 'trim', options: {}, autoRun: false },
  { kind: 'clean', name: 'Lower', source: 'Trimmed', cleaner: 'lowercase', options: {}, autoRun: false },
] }
const setup = insertSetup(uid, 'Trim then lower', null, spec)
if (!('ok' in setup)) throw new Error(JSON.stringify(setup))

function start(sheetId: string): string {
  const plan = planApply(spec, ['Name'])
  if (!('ok' in plan)) throw new Error(JSON.stringify(plan))
  return insertSetupRun({ userId: uid, sheetId, setupId: setup.ok.id, setupName: 'Trim then lower',
    plan: { spec: plan.ok.spec, layers: plan.ok.layers }, targetRowIds: null, allowSecrets: true, autoRun: true })
}

async function main() {
  const sheetId = sheet(['  ADA ', 'Grace  ', ' alan'])
  const id = start(sheetId)

  // An export holds the sheet: the first step waits, the setup doesn't fail.
  let release: () => void = () => {}
  const held = withSheetRead(sheetId, () => new Promise<void>(r => { release = r }))
  await advanceSetupRun(id)
  let view = getSetupRun(uid, id)!
  check('a held sheet leaves the step waiting, the setup running',
    view.status === 'running' && view.steps[0].state === 'waiting', view)
  release()
  await held

  for (let i = 0; i < 100 && getSetupRun(uid, id)!.status === 'running'; i++) {
    await advanceSetupRun(id)
    view = getSetupRun(uid, id)!
    if (view.steps[1].state !== 'waiting') {
      check('the second step starts only after the first one is done', view.steps[0].state === 'done', view)
    }
    await sleep(50)
  }
  view = getSetupRun(uid, id)!
  check('the setup ends done', view.status === 'done', view)
  check('the first step filled its column', JSON.stringify(cells(sheetId, 'Trimmed')) === '["ADA","Grace","alan"]',
    cells(sheetId, 'Trimmed'))
  check('the second read it', JSON.stringify(cells(sheetId, 'Lower')) === '["ada","grace","alan"]',
    cells(sheetId, 'Lower'))

  // Stopped before it moves on: nothing more starts.
  const other = sheet(['X'])
  const stopped = start(other)
  const out = await controlSetupRun(uid, stopped, 'cancel', true)
  check('a stop answers cancelled', 'ok' in out && out.ok.status === 'cancelled', out)
  await advanceSetupRun(stopped)
  check('and starts nothing', getSetupRun(uid, stopped)!.steps.every(s => s.state === 'waiting'),
    getSetupRun(uid, stopped))

  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nall setup-runner checks passed')
  process.exit(0)
}
void main()
