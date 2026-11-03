// The whole-file integrity check runs once per start (lib/db.ts): the process
// that opens the database first checks it and marks DB_CHECKED_ENV; what it starts
// after inherits the mark and skips the check: the lookup worker thread, and the
// job threads inside the worker process Sidequest forks. Each used to read the
// whole file again.
import { spawn } from 'child_process'
import { Worker } from 'worker_threads'
import { createRequire } from 'module'
import dbMod from '../../server/src/lib/db'
import pathMod from '../../server/src/lib/db-path'
import constMod from '../../server/src/lib/constants'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { DB_PATH } = pathMod as typeof import('../../server/src/lib/db-path')
const { DB_CHECKED_ENV } = constMod as typeof import('../../server/src/lib/constants')

const requireHere = createRequire(import.meta.url)
const CHECK_LINE = '📁 SQLite database:'

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

// Opens the database through lib/db.ts, reads a table, prints what it read.
const code = `require(${JSON.stringify(requireHere.resolve('tsx/cjs/api'))}).register();
  const { db } = require(${JSON.stringify(requireHere.resolve('../../server/src/lib/db'))});
  console.log('read', db.prepare('SELECT count(*) FROM sheets').pluck().get());
  db.close();`

// Both answer once the output has ended as well as the code exited: output can
// still be on its way when 'exit' fires.
function inThread(env: NodeJS.ProcessEnv): Promise<string> {
  const w = new Worker(code, { eval: true, env, stdout: true })
  let out = ''
  w.stdout.on('data', chunk => { out += chunk })
  const ended = new Promise<void>(resolve => w.stdout.on('end', resolve))
  const exited = new Promise<number>((resolve, reject) => { w.on('error', reject); w.on('exit', resolve) })
  return Promise.all([exited, ended]).then(([c]) => {
    if (c !== 0) throw new Error(`thread exited ${c}: ${out}`)
    return out
  })
}

function inProcess(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { env, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.on('error', reject)
    // 'close' comes after the output ended, unlike 'exit'.
    child.on('close', c => (c === 0 ? resolve(out) : reject(new Error(`process exited ${c}: ${out}`))))
  })
}

async function main() {
  db.exec(`CREATE TABLE IF NOT EXISTS sheets (id TEXT)`)
  check('the first opener marks the database it checked', process.env[DB_CHECKED_ENV] === DB_PATH,
    process.env[DB_CHECKED_ENV])

  const thread = await inThread(process.env)
  check('a thread it starts opens the database without checking it again',
    !thread.includes(CHECK_LINE) && thread.includes('read'), thread)

  const forked = await inProcess(process.env)
  check('a process it starts skips the check too (Sidequest\'s job threads live in one)',
    !forked.includes(CHECK_LINE) && forked.includes('read'), forked)

  const fresh = await inThread({ ...process.env, [DB_CHECKED_ENV]: '' })
  check('without the mark, opening the database checks it', fresh.includes(CHECK_LINE), fresh)

  const other = await inProcess({ ...process.env, [DB_CHECKED_ENV]: `${DB_PATH}.other` })
  check('a mark for another database file still checks this one', other.includes(CHECK_LINE), other)
}

main()
  .catch(err => { failures++; console.log('FAIL threw', err) })
  .finally(() => {
    db.close()
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  })
