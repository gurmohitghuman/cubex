// The server's stop (lib/server-lifecycle.ts installShutdownHandlers), on the real server (server/src/index.ts) in
// another process with its own database: told to stop (its SIGTERM handlers, called through stdin so it runs the
// same on Windows), it runs Cubex's stop alone (the queue's own handler is off: queue.ts), and ends on its own
// with code 0, idle before STOP_GRACE_MS would cut anything (timed from its own "Shutting down" line, so a slow
// runner's start of the stop isn't counted). A request still waiting for its body is cut after STOP_GRACE_MS, not
// left to the backstop. After a crash (an uncaught exception) it exits 1, so systemd and launchd start it again
// (bin/cubex-service.sh restarts only on a failing exit). Something still keeping the process up is named in the
// log at STOP_BACKSTOP_MS, and the process exits then.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import lifecycleMod from '../../server/src/lib/server-lifecycle'
const { STOP_GRACE_MS, STOP_BACKSTOP_MS } = lifecycleMod as typeof import('../../server/src/lib/server-lifecycle')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

const requireHere = createRequire(import.meta.url)
const mod = (p: string) => JSON.stringify(requireHere.resolve(p))
const freePort = () => new Promise<number>(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as net.AddressInfo
    s.close(() => resolve(port))
  })
})

// ms: from the command sent; fromStop: from the stop's "Shutting down" line.
interface Ended { code: number | null; ms: number; fromStop: number; log: string }

// The server in another process. hold: a timer that keeps the process up whatever the stop closes. Commands on
// stdin once it listens: "stop" (its SIGTERM handlers), "crash" (an uncaught exception).
async function server(hold = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubex-stop-'))
  const port = await freePort()
  const code = `require(${mod('tsx/cjs/api')}).register();
    ${hold ? 'setInterval(() => {}, 1000);' : ''}
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => {
      if (d.includes('stop')) process.emit('SIGTERM', 'SIGTERM');
      if (d.includes('crash')) setImmediate(() => { throw new Error('stop test crash'); });
    });
    // Reading the commands mustn't keep the process up: the stop is what's checked.
    process.stdin.unref();
    require(${mod('../../server/src/index.ts')});`
  const child = spawn(process.execPath, ['-e', code], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'c.db'),
      JOBS_DB_PATH: path.join(dir, 'j.db'), JWT_SECRET: '', APP_ENCRYPTION_KEY: '', NODE_ENV: 'production' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let log = '', stopAt = 0
  const read = (d: Buffer) => {
    log += d
    if (!stopAt && /Shutting down/.test(log)) stopAt = Date.now()
  }
  child.stdout.on('data', read)
  child.stderr.on('data', read)
  let from = 0
  const ended = new Promise<Ended>(resolve => child.on('close', code => {
    const now = Date.now()
    resolve({ code, ms: now - from, fromStop: stopAt ? now - stopAt : NaN, log })
  }))
  for (let i = 0; i < 600 && !/Cubex server running/.test(log); i++) await new Promise(r => setTimeout(r, 50))
  assert.match(log, /Cubex server running/, 'the server started')
  return {
    port,
    send: (what: string) => { from = Date.now(); child.stdin.write(`${what}\n`) },
    ended,
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

await check(`told to stop while idle: Cubex's stop alone, ends on its own with code 0, before the ${STOP_GRACE_MS} ms `
  + 'grace', async () => {
  const s = await server()
  s.send('stop')
  const end = await s.ended
  s.done()
  assert.equal(end.code, 0, end.log)
  // Ending on its own is the point, not how fast: nothing waited for the grace to cut it, or for the backstop.
  assert.ok(end.fromStop < STOP_GRACE_MS, `took ${end.fromStop} ms from "Shutting down" (${end.ms} ms from the stop)`)
  assert.match(end.log, /Shutting down \(SIGTERM\)/)
  assert.match(end.log, /Stopped\./)
  assert.doesNotMatch(end.log, /Received SIGTERM/, 'the queue\'s own handler is off')
  assert.doesNotMatch(end.log, /Still running after the stop/)
})

await check(`a request still waiting for its body is cut after ${STOP_GRACE_MS} ms; the process then ends, code 0`,
  async () => {
    const s = await server()
    const sock = net.connect(s.port, '127.0.0.1')
    await new Promise(r => sock.once('connect', r))
    sock.on('error', () => {})
    const cut = new Promise<void>(r => sock.once('close', () => r()))
    sock.write('POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n'
      + 'Content-Length: 100\r\n\r\n{')
    await new Promise(r => setTimeout(r, 300))
    s.send('stop')
    const end = await s.ended
    await cut
    s.done()
    assert.equal(end.code, 0, end.log)
    assert.ok(end.ms >= STOP_GRACE_MS - 200 && end.ms < STOP_BACKSTOP_MS, `took ${end.ms} ms`)
    assert.doesNotMatch(end.log, /Still running after the stop/)
  })

await check('after a crash (an uncaught exception) it exits 1, so the service manager starts it again', async () => {
  const s = await server()
  s.send('crash')
  const end = await s.ended
  s.done()
  assert.equal(end.code, 1, end.log)
  assert.match(end.log, /UNCAUGHT EXCEPTION/)
  assert.match(end.log, /Shutting down \(uncaughtException\)/)
})

await check(`something still keeping it up is named at ${STOP_BACKSTOP_MS} ms, then it exits with code 0`, async () => {
  const s = await server(true)
  s.send('stop')
  const end = await s.ended
  s.done()
  assert.equal(end.code, 0, end.log)
  assert.ok(end.ms >= STOP_BACKSTOP_MS - 200 && end.ms < STOP_BACKSTOP_MS + 3000, `took ${end.ms} ms`)
  assert.match(end.log, /Still running after the stop, ending it\. Kept up by: .*Timeout/)
})

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('server stop: all passed')
