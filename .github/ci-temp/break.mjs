// Temporary (removed before the review): one change that makes a wait the code must not block on blocking (or
// moves checkpoints onto the API thread), for the break proofs under the disk load. Prints the file it changed:
// `git checkout -- <file>` undoes it.
import fs from 'node:fs'
const SYNC = ms => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});`
const breaks = {
  token: ['server/src/lib/token-last-used.ts', "      db.pragma('busy_timeout = 0');\n", ''],
  stopbusy: ['server/src/services/column-transform-end.ts', "      db.pragma('busy_timeout = 0');\n", ''],
  walturn: ['server/src/lib/wal-turn.ts', '    if (Atomics.compareExchange(walShared, TURN, FREE, PAGE) !== FREE) {',
    '    for (const t0 = Date.now(); Atomics.load(walShared, TURN) !== FREE && Date.now() - t0 < 1000;) '
    + 'Atomics.wait(walShared, TURN, Atomics.load(walShared, TURN), 20);\n'
    + '    if (Atomics.compareExchange(walShared, TURN, FREE, PAGE) !== FREE) {'],
  regex: ['server/src/lib/transform-regex-host.ts', '      w.postMessage(ask);\n',
    `      w.postMessage(ask);\n      ${SYNC('TRANSFORM_REGEX_PAGE_MS')}\n`],
  walslow: ['server/src/lib/wal-checkpointer.ts', '      paused = true;\n',
    `      paused = true;\n      ${SYNC(1100)}\n`],
  mainthread: ['server/src/lib/wal-checkpointer.ts',
    'let workerFile = (): string => join(__dirname, `wal-checkpoint-worker${extname(__filename)}`);',
    "let workerFile = (): string => join(__dirname, 'no-such-worker.js');"],
}
const [file, from, to] = breaks[process.argv[2]]
const src = fs.readFileSync(file, 'utf8')
const eol = src.includes('\r\n') ? s => s.replace(/\n/g, '\r\n') : s => s
if (src.split(eol(from)).length !== 2) throw new Error(`${process.argv[2]}: not found once in ${file}`)
fs.writeFileSync(file, src.replace(eol(from), eol(to)))
console.log(file)
