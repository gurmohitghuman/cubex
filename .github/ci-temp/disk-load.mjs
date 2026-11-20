// Temporary (removed before the review): loads the disk under the folder given until killed. One file is written
// 4 MB at a time over a 1 GB ring, synced every 64 MB, so writeback piles up; another takes 64 KB writes, each
// synced. Every 10 s it prints the slowest write and sync of each.
import fs from 'node:fs'
import path from 'node:path'
const dir = fs.mkdtempSync(path.join(process.argv[2], 'disk-load-'))
const big = fs.openSync(path.join(dir, 'big.bin'), 'w')
const small = fs.openSync(path.join(dir, 'small.bin'), 'w')
const chunk = Buffer.alloc(4 << 20, 1), page = Buffer.alloc(64 << 10, 2)
let n = 0, slowBig = 0, slowSmall = 0, last = Date.now()
const timed = f => { const t = performance.now(); f(); return performance.now() - t }
process.on('SIGTERM', () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0) })
for (;;) {
  slowBig = Math.max(slowBig, timed(() => fs.writeSync(big, chunk, 0, chunk.length, (n % 256) * chunk.length)))
  if (++n % 16 === 0) slowBig = Math.max(slowBig, timed(() => fs.fsyncSync(big)))
  slowSmall = Math.max(slowSmall, timed(() => { fs.writeSync(small, page, 0, page.length, 0); fs.fsyncSync(small) }))
  if (Date.now() - last >= 10_000) {
    console.log(`${n * 4} MB written; slowest: big ${slowBig.toFixed(0)} ms, small ${slowSmall.toFixed(0)} ms`)
    slowBig = slowSmall = 0
    last = Date.now()
  }
  // Lets SIGTERM in.
  if (n % 64 === 0) await new Promise(r => setImmediate(r))
}
