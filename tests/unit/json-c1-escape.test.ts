// JSON answers and event streams carry U+0080-U+009F as \u0080-\u009f escapes,
// whatever writes them (res.json, writeHead then chunks, an event stream), a
// character split across two chunks included, and parse to the same value with
// a correct Content-Length. CSV and plain text keep the raw bytes.
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import escapeMod from '../../server/src/lib/json-c1-escape'
const { escapeC1InJson, escapeC1, escapeC1Bytes } =
  escapeMod as typeof import('../../server/src/lib/json-c1-escape')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const VALUE = 'a\u0085b FraudFighterâ\u0084¢ \u0080\u009F café \u{1F600}'
const RAW_C1 = /\xC2[\x80-\x9F]/

const app = express()
app.use(escapeC1InJson)
app.get('/json', (_req, res) => { res.json({ v: VALUE }) })
app.get('/sent-object', (_req, res) => { res.status(201).send({ v: VALUE }) })
app.get('/parts', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '999' })
  const body = Buffer.from(JSON.stringify({ v: VALUE }), 'utf8')
  const at = body.indexOf(0xC2) + 1 // split right after the first byte of U+0085
  res.write(body.subarray(0, at))
  res.write(body.subarray(at, at + 3))
  res.end(body.subarray(at + 3))
})
app.get('/ending-in-c2', (_req, res) => {
  res.writeHead(200, [['Content-Type', 'application/json']])
  res.write(Buffer.from('"x\xC2', 'latin1'))
  res.end(Buffer.from('\x85"', 'latin1'))
})
app.get('/events', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ v: VALUE })}\n\n`)
  res.end()
})
app.get('/ndjson', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' })
  res.end(`${JSON.stringify({ v: VALUE })}\n`)
})
app.get('/csv', (_req, res) => { res.type('text/csv').send(`"${VALUE}"`) })
app.get('/text', (_req, res) => { res.type('text/plain').send(VALUE) })
// A flat header list whose value is a list itself (two X-Multi headers), and a stale length.
app.get('/flat-list', (_req, res) => {
  res.writeHead(200, ['Content-Type', 'application/json', 'X-Multi', ['a', 'b'], 'Content-Length', '999'])
  res.end(JSON.stringify({ v: VALUE }))
})

const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = (server.address() as AddressInfo).port
const get = (path: string, method = 'GET') =>
  new Promise<{ headers: http.IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path, method }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ headers: res.headers, bytes: Buffer.concat(chunks) }))
    }).on('error', reject).end()
  })

let failures = 0
async function check(label: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}
const escaped = (bytes: Buffer) => {
  const text = bytes.toString('latin1')
  assert.doesNotMatch(text, RAW_C1, 'no raw C2 80-C2 9F in the body')
  for (const e of ['\\u0085', '\\u0084', '\\u0080', '\\u009f']) assert.ok(text.includes(e), `${e} in the body`)
}

await check('the escape text', () => {
  assert.equal(escapeC1('a\u0085b\u0080\u009F\u00A0'), 'a\\u0085b\\u0080\\u009f\u00A0')
  const { out, hold } = escapeC1Bytes(Buffer.from('a\xC2\x85\xC2\xA0\xC2', 'latin1'), false, false)
  assert.equal(out.toString('latin1'), 'a\\u0085\xC2\xA0')
  assert.equal(hold, true)
})
for (const path of ['/json', '/sent-object']) {
  await check(`${path}: escaped, the same value, a Content-Length that fits`, async () => {
    const { headers, bytes } = await get(path)
    escaped(bytes)
    assert.equal(JSON.parse(bytes.toString('utf8')).v, VALUE)
    assert.equal(Number(headers['content-length']), bytes.length)
  })
}
await check('writeHead then chunks, U+0085 split between two: escaped, no stale length', async () => {
  const { headers, bytes } = await get('/parts')
  escaped(bytes)
  assert.equal(JSON.parse(bytes.toString('utf8')).v, VALUE)
  assert.notEqual(headers['content-length'], '999')
})
await check('a chunk ending in C2 (headers as a list of pairs)', async () => {
  const { bytes } = await get('/ending-in-c2')
  assert.equal(bytes.toString('latin1'), '"x\\u0085"')
})
await check('an event stream and NDJSON: escaped, the same value', async () => {
  for (const path of ['/events', '/ndjson']) {
    const { bytes } = await get(path)
    escaped(bytes)
    const line = bytes.toString('utf8').replace(/^data: /, '').trim()
    assert.equal(JSON.parse(line).v, VALUE)
  }
})
await check('a flat header list with a list value: read as pairs, escaped, no stale length', async () => {
  const { headers, bytes } = await get('/flat-list')
  escaped(bytes)
  assert.equal(headers['x-multi'], 'a, b')
  assert.equal(headers.b, undefined)
  assert.notEqual(headers['content-length'], '999')
  assert.equal(JSON.parse(bytes.toString('utf8')).v, VALUE)
})
await check('HEAD through the escape: no body, and no length that GET would not send', async () => {
  const head = await get('/json', 'HEAD')
  const full = await get('/json')
  assert.equal(head.bytes.length, 0)
  assert.ok(head.headers['content-length'] === undefined
    || Number(head.headers['content-length']) === full.bytes.length, `HEAD says ${head.headers['content-length']}`)
  assert.equal(head.headers['content-type'], full.headers['content-type'])
})
await check('CSV and plain text keep the raw bytes', async () => {
  for (const path of ['/csv', '/text']) {
    const { headers, bytes } = await get(path)
    assert.match(bytes.toString('latin1'), RAW_C1)
    assert.ok(bytes.toString('utf8').includes(VALUE))
    assert.equal(Number(headers['content-length']), bytes.length)
  }
})

server.close()
if (failures > 0) { console.error(`${failures} json-c1-escape check(s) failed`); process.exit(1) }
console.log('json-c1-escape: all assertions passed')
