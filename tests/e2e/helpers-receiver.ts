import http from 'node:http'

// A receiver for specs, on 127.0.0.1 only: HTTP API columns and run webhooks
// reach it through Cubex's real outbound path, SSRF guard included, by names
// under .cubex-e2e.invalid (tests/e2e/net-shim.cjs, loaded by the harness).
// Each path answers from a script of replies (the last one repeats) and every
// request is kept: method, path, query, headers, raw body and when it came.
// hold() keeps every answer back until its release is called, so a spec can
// keep an HTTP API run's requests in flight for as long as it needs; settled()
// waits until each request so far was answered or dropped by Cubex.
export interface Hit {
  method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: string; at: number
}
export interface Reply { status: number; headers?: Record<string, string>; body?: string }

export class Receiver {
  readonly port = Number(process.env.E2E_RECEIVER_PORT || 3097)
  readonly hits: Hit[] = []
  private replies = new Map<string, Reply[]>()
  private server: http.Server | null = null
  private gate: { held: Promise<void>; release: () => void } | null = null
  private open = 0

  // The URL Cubex uses; `name` is any label (all go to this receiver).
  url(path: string, name = 'api'): string {
    return `http://${name}.cubex-e2e.invalid:${this.port}${path}`
  }

  on(path: string, ...replies: Reply[]): void { this.replies.set(path, replies) }

  hold(): () => void {
    this.gate?.release()
    let resolve!: () => void
    const held = new Promise<void>(r => { resolve = r })
    const gate = { held, release: () => { if (this.gate === gate) this.gate = null; resolve() } }
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
        void (this.gate?.held ?? Promise.resolve()).then(() => {
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

  stop(): Promise<void> {
    this.gate?.release()
    return new Promise(resolve => (this.server ? this.server.close(() => resolve()) : resolve()))
  }
}
