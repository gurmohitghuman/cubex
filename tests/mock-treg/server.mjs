// A stand-in for treg.to: scripts/e2e-harness.mjs starts it and points the
// server at it through TREG_BASE_URL, so no spec ever reaches the real treg.
// It answers the account reads, the public catalog and /access from fixtures
// captured live on 2026-10-07 (anonymized, see README.md). Tool calls
// run through calls.mjs (waterfalls simulated in waterfall.mjs).
//
//   node tests/mock-treg/server.mjs [port]      (default 3098, or MOCK_TREG_PORT)
//   GET/POST /__mock/state, POST /__mock/reset, GET /__mock/requests, GET /__mock/billing
import http from 'node:http'
import { accountRoute } from './account.mjs'
import { catalogRoute } from './catalog.mjs'
import { adminRoute, logRequest, state } from './state.mjs'
import { callRoute, resetCalls } from './calls.mjs'

const port = Number(process.argv[2] || process.env.MOCK_TREG_PORT || 3098)
const MAX_BODY = 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  let body = ''
  try { body = await readBody(req) } catch { return send(413, { detail: 'too large' }) }
  const url = new URL(req.url, 'http://mock-treg')
  if (url.pathname === '/health') return send(200, { ok: true })
  if (url.pathname.startsWith('/__mock/')) {
    if (url.pathname === '/__mock/reset') resetCalls()
    return adminRoute(req, url, body, send)
  }
  logRequest(req, url, body)
  // An unreachable treg: the connection drops with no answer.
  if (state.down) { req.socket.destroy(); return }
  // A bad request (a malformed %-escape) answers 500 instead of taking the
  // mock down for every spec after it.
  let answer
  try { answer = accountRoute(req, url) ?? catalogRoute(req, url) ?? await callRoute(req, url, body) }
  catch (error) { return send(500, { detail: `mock treg: ${error.message}` }) }
  if (!answer) return send(404, { detail: 'Not Found' })
  send(answer.status, answer.body, answer.headers)
})

server.on('error', error => { console.error(`mock treg: ${error.message}`); process.exit(1) })
server.listen(port, '127.0.0.1', () => console.log(`mock treg on http://127.0.0.1:${port}`))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
