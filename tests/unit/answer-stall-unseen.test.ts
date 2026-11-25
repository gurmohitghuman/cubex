// The deadline on an answer whose client stopped reading it (lib/answer-stall.ts), where the system shows no
// progress inside a write: Windows, or a Node without libuv's queue size (here hidden on the socket's handle, so it
// runs on every system). The deadline is at 1 s and the write in flight gets one more second per 2 MB. Without the
// queue size, progress is the finished writes and the data waiting is unseen; on Windows the queue's size is. A
// file still reaches a steady reader and is cut for a stalled one; one 16 MB write still reaches a steady reader,
// and a stalled one is cut once its 8 s more have passed. What piles up after data last moved adds nothing: a stream
// still writing is cut all the same. A CSV export goes out in writes of at most 1 MB, its bytes whole.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Socket } from 'node:net'
import { stallKit } from './answer-stall-kit'

// Read when the modules load, so before the imports below.
process.env.RESPONSE_STALL_TIMEOUT_MS = '1000'
process.env.RESPONSE_MIN_KB_PER_SECOND = '2048'
const STALL = 1000
const RATE = 2048 * 1024
// A steady reader here reads at twice the pace the wait grows by, whatever size of chunk the system hands it: one a
// tick (every 10 ms) is about 800 KB/s on a Mac, whose Unix sockets buffer 8 KB, so one 16 MB write was cut there.
const PACE = 2 * RATE
const express = (await import('express')).default
const { answerStall, progressOf } = await import('../../server/src/lib/answer-stall')
const { responseWriter } = await import('../../server/src/lib/csv-write')
const { check, logged, tagged, listen, stalled, steady } = stallKit('unseen')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unseen-'))
const BIG = 16 * 1024 * 1024
fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(BIG, 120))
const app = express()
app.use(tagged)
app.use(answerStall)
// The socket's handle without libuv's queue size, then a file, or one large write.
app.use((req, _res, next) => {
  const handle = (req.socket as Socket & { _handle?: object })._handle
  if (handle) Object.defineProperty(handle, 'writeQueueSize', { get: () => undefined })
  next()
}, express.static(dir))
app.get('/one', (_req, res) => { res.type('application/octet-stream').end(Buffer.alloc(BIG, 120)) })
// Writing on whatever the client does: 64 KB every 10 ms, faster than the 2 MB a second the wait grows by.
app.get('/events', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const tick = setInterval(() => res.write(`data: ${'x'.repeat(65_536)}\n\n`), 10)
  res.on('close', () => clearInterval(tick))
})
const closeServer = await listen(app)

// What a socket reports, from its handle: no handle, no queue size, one that isn't a number, and one.
{
  const fake = (handle: unknown) =>
    ({ bytesWritten: 100, writableLength: 40, _handle: handle }) as unknown as Socket
  const read = [null, undefined, {}, { writeQueueSize: 'x' }, { writeQueueSize: 7 }].map(h => progressOf(fake(h)))
  const unseenOf7 = process.platform === 'win32' ? 7 : 0
  check('without the queue size, progress is the bytes handed over and all 40 waiting are unseen; with it, '
    + `${unseenOf7} of 7 queued`, read.every((r, i) => r.handed === 60 && r.queued === (i === 4 ? 7 : 0)
    && r.unseen === (i === 4 ? unseenOf7 : 40)), read)
}

// A file goes out in writes of 64 KB: their progress shows, whatever the system.
{
  const r = await steady('/big.bin', PACE)
  check(`a steady reader of a file gets all of it over ${r.ms} ms`, r.got[0]?.bytes === BIG
    && r.got[0].length === BIG && r.ms > 2 * STALL, r)
  const cut = await stalled('/big.bin')
  check(`a file to a client that stopped reading: cut after ${cut} ms`, cut >= STALL - 100 && cut < 3 * STALL + 500,
    cut)
}

// One large write shows nothing until all of it is out: it gets its size's time.
{
  const r = await steady('/one', PACE)
  check(`a steady reader of one 16 MB write gets all of it over ${r.ms} ms`, r.got[0]?.bytes === BIG
    && r.got[0].length === BIG && r.ms > 2 * STALL, r)
  const more = (BIG / RATE) * 1000
  const cut = await stalled('/one', {}, undefined, STALL + more + 5000)
  check(`one 16 MB write to a client that stopped reading: cut after ${cut} ms, ${more} ms past the deadline`,
    cut >= STALL + more - 1000 && cut < 3 * STALL + more + 500, cut)
}

// What piles up after data last moved adds no time: a stream still writing is cut all the same.
{
  const cut = await stalled('/events', {}, undefined, 15_000)
  check(`a stream still writing to a client that stopped reading: cut after ${cut} ms`, cut >= STALL && cut < 8000,
    cut)
}

// A CSV export's page goes out in writes of at most 1 MB, every byte in order.
{
  const page = 'é,ü,€\r\n'.repeat(250_000)
  const parts: Buffer[] = []
  const fakeRes = { destroyed: false, write: (b: Buffer) => { parts.push(Buffer.from(b)); return true } }
  const more = await responseWriter(fakeRes as unknown as import('express').Response)(page)
  check(`a ${Buffer.byteLength(page)}-byte page goes out in ${parts.length} writes of at most 1 MB, whole`,
    more && parts.length === 3 && parts.every(b => b.length <= 1024 * 1024)
    && Buffer.concat(parts).equals(Buffer.from(page)), parts.map(b => b.length))
}

check('nothing logged', logged.length === 0, logged.slice(0, 3))
fs.rmSync(dir, { recursive: true, force: true })
closeServer()
console.log('\nall unseen progress checks passed')
