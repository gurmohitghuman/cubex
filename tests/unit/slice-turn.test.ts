// One bulk writer's slice a turn (lib/slice-turn.ts): the next slice waits until the event loop has polled for
// requests since the last was written, even when that one was written in the poll phase (after a worker's answer, or
// a socket's data). One immediate isn't enough there: it runs in the same turn's check phase, before the next poll, so
// the next slice would begin with a request's data already waiting unread. The second immediate is what lets it in.
import assert from 'node:assert/strict'
import net from 'node:net'
import turnMod from '../../server/src/lib/slice-turn'
const { takeSliceTurn } = turnMod as typeof import('../../server/src/lib/slice-turn')

let failures = 0
async function check(label: string, fn: () => Promise<void>) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}

// A connected pair on loopback: what `client` writes is readable on `server` at once, read in the next poll.
async function pair(): Promise<{ client: net.Socket; server: net.Socket; close: () => void }> {
  const listener = net.createServer()
  await new Promise<void>(r => listener.listen(0, '127.0.0.1', r))
  const port = (listener.address() as net.AddressInfo).port
  const accepted = new Promise<net.Socket>(r => listener.once('connection', r))
  const client = net.connect(port, '127.0.0.1')
  await new Promise<void>(r => client.once('connect', r))
  const server = await accepted
  return { client, server, close: () => { client.destroy(); server.destroy(); listener.close() } }
}

async function main() {
  const pollPhase = 'a slice written in the poll phase: the next one begins after the data then waiting was read'
  await check(pollPhase, async () => {
    const trigger = await pair()
    const probe = await pair()
    try {
      const read: string[] = []
      probe.server.on('data', d => { read.push(String(d)) })
      const first = await takeSliceTurn()
      // Another writer waits for the turn, noting what had been read when it got it.
      let seenAtTurn: string[] | null = null
      const second = takeSliceTurn().then(done => { seenAtTurn = [...read]; done() })
      // In the poll phase (a socket's data): a request arrives for the probe, then the slice is written.
      trigger.server.once('data', () => {
        probe.client.write('request')
        // The slice takes a moment, holding the loop as a real one does: the request is surely waiting by its end,
        // on Windows too (where the kernel reports a loopback read through the completion port).
        const until = Date.now() + 10
        while (Date.now() < until) { /* writing the slice */ }
        first()
      })
      trigger.client.write('go')
      await second
      assert.deepEqual(seenAtTurn, ['request'], 'the next slice began before the waiting request was read')
    } finally { trigger.close(); probe.close() }
  })

  await check('the turn is held: a second writer waits until the first is written', async () => {
    const order: string[] = []
    const first = await takeSliceTurn()
    const second = takeSliceTurn().then(done => { order.push('second'); done() })
    await new Promise(r => setTimeout(r, 20))
    order.push('first written')
    first()
    await second
    assert.deepEqual(order, ['first written', 'second'])
  })

  if (failures > 0) { console.error(`${failures} slice-turn check(s) failed`); process.exit(1) }
  console.log('slice-turn: all assertions passed')
}
void main()
