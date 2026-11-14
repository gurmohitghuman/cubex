// A deadline longer than setTimeout's longest wait (2,147,483,647 ms, about 24.8 days) is capped at it
// (lib/request-deadline.ts waitMs), not left to overflow: an overflowing wait fires after 1 ms, so every request
// with a body would get 408. With REQUEST_BODY_TIMEOUT_MS at 3,000,000,000, a body sent in two parts 300 ms
// apart still arrives, and the wait left is never more than the cap.
import type { AddressInfo } from 'node:net'
import net from 'node:net'

// Read when the module loads, so before the import below.
process.env.REQUEST_BODY_TIMEOUT_MS = '3000000000'
const express = (await import('express')).default
const { REQUEST_BODY_TIMEOUT_MS, requestDeadline, waitMs } = await import('../../server/src/lib/request-deadline')

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

check('the setting is read as 3,000,000,000 ms', REQUEST_BODY_TIMEOUT_MS === 3_000_000_000, REQUEST_BODY_TIMEOUT_MS)
const now = Date.now()
check('the wait left is capped at 2,147,483,647 ms', waitMs(now, REQUEST_BODY_TIMEOUT_MS) === 2_147_483_647)
check('... and is the time left below the cap, never under 0', waitMs(now, 60_000) <= 60_000
  && waitMs(now, 60_000) > 59_000 && waitMs(now - 5000, 1000) === 0)

const app = express()
app.use(requestDeadline)
app.post('/echo', express.json(), (req, res) => { res.json(req.body) })
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = (server.address() as AddressInfo).port

const answer = await new Promise<string>(resolve => {
  const sock = net.connect(port, '127.0.0.1')
  let text = ''
  const body = '{"a":"two parts"}'
  sock.write(`POST /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n`
    + `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.slice(0, 8)}`)
  setTimeout(() => sock.write(body.slice(8)), 300)
  const giveUp = setTimeout(() => sock.destroy(), 5000)
  sock.on('data', d => { text += d.toString() })
  sock.on('error', () => {})
  sock.on('close', () => { clearTimeout(giveUp); resolve(text) })
})
check('a body sent in two parts 300 ms apart arrives (200, echoed back)', answer.startsWith('HTTP/1.1 200')
  && answer.includes('{"a":"two parts"}'), answer.split('\r\n')[0])

server.close()
server.closeAllConnections()
if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall request deadline cap checks passed')
