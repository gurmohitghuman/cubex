// Shared by the tests of the deadline on an answer whose client stopped reading it (answer-stall, -slow and -unseen)
// and of an export's end (export-stop): the check and log capture, a server on a Unix socket (a named pipe on Windows)
// with the server's timeouts, the time each tagged connection closed, and clients that never read or read a chunk every
// 10 ms. A Unix socket, not TCP: TCP's buffers here grow to 32 MB a side and would take a stalled answer whole. A Unix
// socket's are small and fixed, and answers go out through the same Node stream code either way. The client can't see a
// hang-up it doesn't read, so the server's sockets are watched.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Express, NextFunction, Request, Response } from 'express'

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Got = { status: number; bytes: number; length: number }

export function stallKit(name: string) {
  let failures = 0
  const check = (label: string, cond: boolean, detail?: unknown) => {
    if (cond) console.log('ok  ', label)
    else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
  }
  const logged: string[] = []
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }

  const SOCK = process.platform === 'win32' ? `\\\\.\\pipe\\cubex-${name}-${process.pid}`
    : path.join(os.tmpdir(), `${name}-${process.pid}.sock`)
  // Mounted first: when each connection tagged ?c=<n> closed.
  const closedAt = new Map<string, number>()
  const tagged = (req: Request, _res: Response, next: NextFunction) => {
    const tag = req.query.c
    if (typeof tag === 'string') req.socket.once('close', () => closedAt.set(tag, Date.now()))
    next()
  }
  // Loaded here, so after the test has set its environment.
  const listen = async (app: Express) => {
    const { applyServerTimeouts } = await import('../../server/src/lib/server-timeouts')
    const server = app.listen(SOCK)
    applyServerTimeouts(server)
    server.keepAliveTimeout = 3000
    await new Promise(r => server.once('listening', r))
    return () => {
      server.close()
      server.closeAllConnections()
      if (process.platform !== 'win32') fs.rmSync(SOCK, { force: true })
      if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
    }
  }

  // A connection sending its requests, several pipelined if given.
  const open = (paths: string | string[], headers: Record<string, string> = {}) => {
    const c = net.connect(SOCK)
    c.on('error', () => {})
    c.write([paths].flat().map(p => [`GET ${p} HTTP/1.1`, 'Host: localhost',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n').join(''))
    return c
  }
  // A client that sends its requests (the first tagged ?c=<n>) and never reads: ms until the server closed the
  // connection (-1: not within `giveUpMs`).
  let tags = 0
  async function stalled(paths: string | string[], headers: Record<string, string> = {},
    during?: () => Promise<void>, giveUpMs = 8000) {
    const tag = String(++tags)
    const [p, ...rest] = [paths].flat()
    const c = open([`${p}${p.includes('?') ? '&' : '?'}c=${tag}`, ...rest], headers)
    await new Promise(r => c.once('connect', r))
    const started = Date.now()
    await during?.()
    while (!closedAt.has(tag) && Date.now() - started < giveUpMs) await sleep(20)
    c.destroy()
    return closedAt.has(tag) ? closedAt.get(tag)! - started : -1
  }
  // A client that sends its requests and reads a chunk at a time, one every 10 ms, until every answer is in or the
  // server hangs up: each answer's status, body bytes and declared length, and the time.
  function steady(paths: string | string[]): Promise<{ got: Got[]; ms: number }> {
    return new Promise(resolve => {
      const c = open(paths)
      const started = Date.now(), got: Got[] = []
      let head = ''
      const done = () => { c.destroy(); resolve({ got, ms: Date.now() - started }) }
      c.on('data', (d: Buffer) => {
        for (let rest = d.toString('latin1'); rest;) {
          const body = got.at(-1)
          if (body && body.bytes < body.length) {
            const take = Math.min(rest.length, body.length - body.bytes)
            body.bytes += take
            rest = rest.slice(take)
            continue
          }
          head += rest
          const cut = head.indexOf('\r\n\r\n')
          if (cut < 0) break
          const status = Number(head.slice(9, 12))
          got.push({ status, bytes: 0, length: Number(/content-length: (\d+)/i.exec(head.slice(0, cut))?.[1]) })
          rest = head.slice(cut + 4)
          head = ''
        }
        const last = got.at(-1)
        if (got.length === [paths].flat().length && last!.bytes >= last!.length) return done()
        c.pause()
        setTimeout(() => c.resume(), 10)
      })
      c.on('close', done)
    })
  }
  return { check, logged, closedAt, tagged, listen, open, stalled, steady, sock: SOCK }
}
