// The OpenRouter keep-alive pool closes idle sockets (lib/openrouter-agent.ts).
// Without an idle limit, a run that starts after a quiet spell reuses
// connections upstream already dropped, and its whole first wave fails with
// "Connection error. (EPIPE)". The limit can't be the agent's `timeout` option:
// the OpenAI SDK raises that to its request timeout + 1s on the first request.
// So this checks, on this Node version, that with the SDK's raised value in
// place an idle pooled socket still closes at our limit, and that a request on
// a pooled socket that runs longer than the limit still completes.
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import agentMod from '../../server/src/lib/openrouter-agent'
const { openrouterAgent, withIdleLimit } = agentMod as typeof import('../../server/src/lib/openrouter-agent')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const get = (agent: http.Agent, url: string) => new Promise<string>((resolve, reject) => {
  http.get(url, { agent }, res => {
    let body = ''
    res.on('data', c => { body += c })
    res.on('end', () => resolve(body))
  }).on('error', reject)
})

;(async () => {
  assert.equal(openrouterAgent.options.timeout, undefined, 'no agent timeout for the SDK to raise')
  assert.ok(openrouterAgent.options.keepAlive, 'the pool keeps sockets for reuse')

  // Same mechanism with a 200ms limit so the test runs in about a second.
  const server = http.createServer((req, res) => { setTimeout(() => res.end('ok'), req.url === '/slow' ? 600 : 0) })
  server.keepAliveTimeout = 60_000 // the server never closes an idle socket itself
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const agent = new (withIdleLimit(http.Agent, 200))({ keepAlive: true, maxSockets: 1 })
  agent.options.timeout = 181_000 // what the OpenAI SDK does to its agent
  const pooled = () => Object.values(agent.freeSockets).flat().length

  assert.equal(await get(agent, `${base}/fast`), 'ok')
  await sleep(20)
  assert.equal(pooled(), 1, 'the socket is kept for reuse')
  assert.equal(await get(agent, `${base}/slow`), 'ok', 'a request on a pooled socket outlasting the limit completes')
  await sleep(20)
  assert.equal(pooled(), 1, 'the socket is pooled again afterwards')
  await sleep(450)
  assert.equal(pooled(), 0, 'an idle socket is closed at the limit, not the raised agent timeout')

  agent.destroy()
  server.close()
  console.log('All openrouter-agent idle-limit assertions passed.')
})().catch(e => { console.error(e); process.exit(1) })
