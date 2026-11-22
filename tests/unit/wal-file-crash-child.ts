// The child of wal-file-crash.test.ts: on its own database (DB_PATH), the -wal file made its full size
// (lib/wal-file.ts), then batches of CRASH_ROWS rows committed one after another, each batch's number written out
// once its commit has returned, until the process is killed.
import { writeSync } from 'node:fs'
import { db } from '../../server/src/lib/db'
import { setWalFileSizingForTests, sizeWalFile } from '../../server/src/lib/wal-file'

const rows = Number(process.env.CRASH_ROWS)
// Straight to the pipe: a batch's line is out before the next commit begins.
const say = (line: string) => { writeSync(1, `${line}\n`) }
db.exec('CREATE TABLE IF NOT EXISTS crash_rows (batch INTEGER NOT NULL, i INTEGER NOT NULL, pad TEXT NOT NULL)')
setWalFileSizingForTests(true)
say('sizing')
say(`ready ${sizeWalFile(db, process.env.DB_PATH!).done}`)
const insert = db.prepare('INSERT INTO crash_rows (batch, i, pad) VALUES (?, ?, ?)')
const pad = 'x'.repeat(1000)
let batch = (db.prepare('SELECT COALESCE(MAX(batch), 0) FROM crash_rows').pluck().get() as number) + 1
for (;;) {
  const b = batch++
  db.transaction(() => { for (let i = 0; i < rows; i++) insert.run(b, i, pad) }).immediate()
  say(String(b))
}
