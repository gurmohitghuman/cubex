import http from 'node:http'
import { expect, type APIRequestContext } from '@playwright/test'

// A receiver for specs, on 127.0.0.1 only: HTTP API columns and run webhooks
// reach it through Cubex's real outbound path, SSRF guard included, by names
// under .cubex-e2e.invalid (tests/e2e/net-shim.cjs, loaded by the harness).
// Each path answers from a script of replies (the last one repeats) and every
// request is kept: method, path, query, headers, raw body and when it came.
// hold() keeps every answer back (or only those on the paths it's given) until
// its release is called, so a spec can keep an HTTP API run's requests in
// flight for as long as it needs; settled() waits until each request so far
// was answered or dropped by Cubex. Every spec's receiver takes the same port,
// so a spec counts requests on its own paths (hitsOn), never all of them.
export interface Hit {
  method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: string; at: number
}
export interface Reply { status: number; headers?: Record<string, string>; body?: string }

export class Receiver {
  readonly port = Number(process.env.E2E_RECEIVER_PORT || 3097)
  private readonly hits: Hit[] = []
  private replies = new Map<string, Reply[]>()
  private server: http.Server | null = null
  private gate: { held: Promise<void>; paths: Set<string> | null; release: () => void } | null = null
  private open = 0

  // The URL Cubex uses; `name` is any label (all go to this receiver).
  url(path: string, name = 'api'): string {
    return `http://${name}.cubex-e2e.invalid:${this.port}${path}`
  }

  on(path: string, ...replies: Reply[]): void { this.replies.set(path, replies) }

  hold(paths?: string[]): () => void {
    this.gate?.release()
    let resolve!: () => void
    const held = new Promise<void>(r => { resolve = r })
    const gate = {
      held, paths: paths ? new Set(paths) : null,
      release: () => { if (this.gate === gate) this.gate = null; resolve() },
    }
    this.gate = gate
    return gate.release
  }

  hitsOn(path: string): Hit[] { return this.hits.filter(h => h.path === path) }

  async settled(timeoutMs = 20_000): Promise<void> {
    const until = Date.now() + timeoutMs
    while (this.open > 0) {
      if (Date.now() > until) throw new Error(`${this.open} requests still open`)
      await new Promise(r => setTimeout(r, 50))
    }
  }

  async waitFor(path: string, count: number, timeoutMs = 20_000): Promise<Hit[]> {
    const until = Date.now() + timeoutMs
    while (this.hitsOn(path).length < count) {
      if (Date.now() > until) throw new Error(`${path}: ${this.hitsOn(path).length} of ${count} requests came`)
      await new Promise(r => setTimeout(r, 100))
    }
    return this.hitsOn(path)
  }

  start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://receiver')
        this.hits.push({
          method: req.method ?? '', path: u.pathname, query: u.searchParams, headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'), at: Date.now(),
        })
        const script = this.replies.get(u.pathname)
        const reply = script ? (script.length > 1 ? script.shift()! : script[0]) : { status: 404, body: '{}' }
        this.open++
        res.once('close', () => { this.open-- })
        const gate = this.gate && (!this.gate.paths || this.gate.paths.has(u.pathname)) ? this.gate : null
        void (gate?.held ?? Promise.resolve()).then(() => {
          if (res.destroyed) return
          res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) })
          res.end(reply.body ?? '{}')
        })
      })
    })
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.port, '127.0.0.1', () => resolve())
    })
  }

  // close() waits for every connection to end, so a kept-alive one could hold it: they are all closed too.
  stop(): Promise<void> {
    this.gate?.release()
    const server = this.server
    if (!server) return Promise.resolve()
    return new Promise(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
}

// Run webhooks are account-wide: one a spec leaves behind sends every later
// run's notice to whichever spec's receiver has the port then. A spec that
// makes them calls this in beforeAll (what an earlier one left) and afterAll
// (its own), before stopping its receiver. Specs share the account one at a
// time, so after its beforeAll every run webhook there is the spec's own.
export async function deleteRunWebhooks(api: APIRequestContext): Promise<void> {
  const list = await api.get('/api/settings/run-webhooks')
  expect(list.ok(), await list.text()).toBeTruthy()
  for (const h of (await list.json()).webhooks as Array<{ id: string }>) {
    const res = await api.delete(`/api/settings/run-webhooks/${h.id}`)
    expect(res.ok(), await res.text()).toBeTruthy()
  }
}
