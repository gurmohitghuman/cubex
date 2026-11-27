// Which redirects an HTTP API row follows, and with what (lib/http-redirect.ts, pure). The request path runs the full
// outbound guard on every hop (lib/http-request.ts); the e2e spec http-redirects covers that end to end.
import assert from 'node:assert/strict'
import mod from '../../server/src/lib/http-redirect'
import classifyMod from '../../server/src/lib/http-error-classify'
const { nextHop, HTTP_MAX_REDIRECTS } = mod as typeof import('../../server/src/lib/http-redirect')
const { classifyHttpError } = classifyMod as typeof import('../../server/src/lib/http-error-classify')

const get = { url: 'https://api.example.com/v1/people?q=x', method: 'GET', body: undefined,
  headers: { Accept: 'application/json', 'X-Api-Key': 'k', Authorization: 'Bearer t', 'User-Agent': 'u' } }
const ok = (r: ReturnType<typeof nextHop>) => { assert.ok(r && 'ok' in r, JSON.stringify(r)); return r.ok }

// Not a redirect to follow: the answer stays the answer.
for (const s of [200, 304, 300, 404, 500]) assert.equal(nextHop(get, s, '/elsewhere'), null, `status ${s}`)
assert.equal(nextHop(get, 302, undefined), null, 'no Location')
assert.equal(nextHop(get, 302, '  '), null)

// Same origin: relative Location resolved, every header kept.
const same = ok(nextHop(get, 301, '/v2/people?q=x'))
assert.equal(same.url, 'https://api.example.com/v2/people?q=x')
assert.deepEqual(same.headers, get.headers)
assert.equal(ok(nextHop(get, 302, ['https://api.example.com/a', 'ignored'])).url, 'https://api.example.com/a')
console.log('ok   same origin: the Location resolved, the headers kept')

// Another origin (host, scheme or port): only Accept, Accept-Language and User-Agent go along.
for (const to of ['https://www.example.com/v1/people', 'https://api.example.com:8443/v1', 'https://other.example/x']) {
  assert.deepEqual(ok(nextHop(get, 308, to)).headers, { Accept: 'application/json', 'User-Agent': 'u' }, to)
}
// The same host moving to TLS on the default ports keeps them (the key already went there, now encrypted); another
// port or host doesn't.
const http = { ...get, url: 'http://api.example.com/v1' }
assert.deepEqual(ok(nextHop(http, 301, 'https://api.example.com/v1')).headers, get.headers, 'http to https, same host')
assert.deepEqual(ok(nextHop({ ...get, url: 'http://api.example.com:80/v1' }, 301, 'https://api.example.com:443/v1'))
  .headers, get.headers, 'the default ports written out')
const keys = (to: string) => Object.keys(ok(nextHop(http, 301, to)).headers)
assert.deepEqual(keys('https://api.example.com:8443/v1'), ['Accept', 'User-Agent'])
assert.deepEqual(keys('https://www.example.com/v1'), ['Accept', 'User-Agent'])
console.log('ok   another origin: no key, token or cookie goes along; the same host moving to https keeps them')

// Never https to http, never another scheme, never an unreadable address.
assert.match((nextHop(get, 302, 'http://api.example.com/x') as { error: string }).error, /from https to http/)
assert.match((nextHop(get, 302, 'ftp://api.example.com/x') as { error: string }).error, /only http and https/)
assert.match((nextHop(get, 302, 'http://[bad') as { error: string }).error, /isn't a URL/)
console.log('ok   refused: https to http, other schemes, an address that isn\'t a URL')

// Methods and bodies: 303, and 301 or 302 after a POST, go on as GET without body or its content type; 307 and 308
// keep both, on the same origin only.
const post = { url: 'https://api.example.com/v1', method: 'POST', body: '{"key":"secret"}',
  headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'k' } }
for (const s of [301, 302, 303]) {
  const h = ok(nextHop(post, s, '/done'))
  assert.deepEqual([h.method, h.body, Object.keys(h.headers)], ['GET', undefined, ['X-Api-Key']], `status ${s}`)
}
for (const s of [307, 308]) {
  const h = ok(nextHop(post, s, '/v2'))
  assert.deepEqual([h.method, h.body, h.headers], ['POST', post.body, post.headers], `status ${s}`)
  assert.match((nextHop(post, s, 'https://other.example/v2') as { error: string }).error, /with a body to another host/)
}
assert.equal(ok(nextHop({ ...get, method: 'HEAD' }, 303, '/x')).method, 'HEAD')
assert.equal(ok(nextHop({ ...get, method: 'PUT', body: 'b' }, 302, '/x')).method, 'PUT', 'only a POST turns into a GET')
console.log('ok   303 and a POST\'s 301 or 302 go on as GET without a body; 307 and 308 keep it, on the same origin')

assert.equal(HTTP_MAX_REDIRECTS, 5)

// The errors a refused redirect writes read as the API's setup, not as unknown.
for (const m of ['HTTP 302 redirected from https to http (x.example); Cubex doesn\'t follow that.',
  'A redirect was refused: Could not resolve x.example.', 'More than 5 redirects in a row.']) {
  assert.equal(classifyHttpError(m), 'configuration', m)
}
console.log('ok   a refused redirect reads as the API\'s setup')
console.log('http-redirect: all assertions passed')
