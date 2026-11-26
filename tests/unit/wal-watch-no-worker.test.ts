// The WAL watch (lib/wal-watch.ts) when the checkpoint worker can't start at all: the mark never goes in the
// environment, so a thread opened after (as a run's job thread, or the job process forked once walWatchReady
// answered) checkpoints its own at 2,000 as before, and so does this connection. Its own file: a worker that couldn't
// start leaves checkpoints on the main thread for the rest of the process.
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import dbMod from '../../server/src/lib/db'
import constMod from '../../server/src/lib/constants'
import walMod from '../../server/src/lib/wal-checkpointer'
import watchMod from '../../server/src/lib/wal-watch'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { DB_AUTO_CHECKPOINT_FRAMES, WAL_WATCHED_ENV } = constMod as typeof import('../../server/src/lib/constants')
const { checkpointsOnWorker, closeWalCheckpointer, setCheckpointWorkerFileForTests } =
  walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { startWalWatch, stopWalWatch, walWatchReady } = watchMod as typeof import('../../server/src/lib/wal-watch')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const logged: string[] = []
console.error = (...a: unknown[]) => { logged.push(String(a[0])) }
const requireHere = createRequire(import.meta.url)
const auto = () => db.pragma('wal_autocheckpoint', { simple: true }) as number

// A thread with its own connection (lib/db.ts), as a run's job has: its SQLite checkpoint mark.
function threadsMark(): Promise<number> {
  const tsx = requireHere.resolve('tsx/cjs/api')
  const dbFile = requireHere.resolve('../../server/src/lib/db')
  const code = `require(${JSON.stringify(tsx)}).register();
    const { parentPort } = require('node:worker_threads');
    const { db } = require(${JSON.stringify(dbFile)});
    parentPort.postMessage(db.pragma('wal_autocheckpoint', { simple: true }));`
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true })
    w.once('message', m => { void w.terminate(); resolve(m as number) })
    w.once('error', reject)
  })
}

setCheckpointWorkerFileForTests('/nonexistent/wal-checkpoint-worker.js')
try {
  startWalWatch()
  await walWatchReady()
  assert.equal(checkpointsOnWorker(), false, 'the worker could not start')
  assert.equal(process.env[WAL_WATCHED_ENV], undefined, 'no mark for threads and processes started from now on')
  assert.equal(auto(), DB_AUTO_CHECKPOINT_FRAMES, 'this connection checkpoints its own at 2,000')
  assert.equal(await threadsMark(), DB_AUTO_CHECKPOINT_FRAMES, 'a thread opened after: 2,000, not the room')
  assert.equal(logged.filter(l => /checkpoint worker could not start/.test(l)).length, 1, logged.join('\n'))
} finally {
  setCheckpointWorkerFileForTests(null)
  stopWalWatch()
  await closeWalCheckpointer()
}
console.log('All wal-watch-no-worker checks passed.')
