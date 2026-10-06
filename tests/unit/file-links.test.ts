// One-time file links (server/src/lib/file-links.ts): only a hash is stored, a
// link works once, for its own kind, until it expires and while the access
// token that made it is valid, and goes with its sheet. Also pinned: where
// links point (linkBase) and the upload size cap (services/csv-upload.ts).
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import linksMod from '../../server/src/lib/file-links'
import uploadMod from '../../server/src/services/csv-upload'
import uploadsMod from '../../server/src/lib/uploads'
import redactMod from '../../server/src/lib/redact'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { createFileLink, findFileLink, useFileLink, releaseFileLink, linkOptions, linkBase, fileLinkUrl } =
  linksMod as typeof import('../../server/src/lib/file-links')
const { receive, importUploadedCsv } = uploadMod as typeof import('../../server/src/services/csv-upload')
const { prepareUploadDir, UPLOAD_DIR } = uploadsMod as typeof import('../../server/src/lib/uploads')
const { redactSecrets } = redactMod as typeof import('../../server/src/lib/redact')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const sheet = () => {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position) VALUES (?,?,?,?,0)').run(id, tid, uid, `S_${id.slice(0, 8)}`)
  return id
}
const accessToken = (name: string) => {
  const id = uuid()
  db.prepare('INSERT INTO access_tokens (id,user_id,name,token_hash,token_prefix,scopes) VALUES (?,?,?,?,?,?)')
    .run(id, uid, name, crypto.randomBytes(32).toString('hex'), 'cubex_pat_x', 'read,write')
  return id
}
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const count = (token: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM file_links WHERE token_hash = ?').get(sha(token)) as { n: number }).n
const make = (tokenId: string, sheetId: string, kind: 'upload' | 'download', options: Record<string, unknown> = {}) =>
  createFileLink({ userId: uid, tokenId, sheetId, kind, options })

const tok = accessToken('main')
const s1 = sheet()

// A link is 32 random bytes; only their sha256 is stored, and it expires in 15 minutes.
const up = make(tok, s1, 'upload', { mode: 'replace' })
assert.match(up.token, /^[0-9a-f]{64}$/)
const stored = db.prepare('SELECT * FROM file_links WHERE token_hash = ?').get(sha(up.token)) as Record<string, unknown>
assert.ok(stored, 'stored by its hash')
assert.ok(!JSON.stringify(stored).includes(up.token), 'the token itself is never stored')
const minutes = (Date.parse(up.expiresAt) - Date.now()) / 60_000
assert.ok(minutes > 14.9 && minutes <= 15, `expires in 15 minutes, got ${minutes}`)

// It works once, for its own kind only.
assert.equal(findFileLink(up.token, 'download'), null, 'an upload link is no download link')
const found = findFileLink(up.token, 'upload')
assert.ok(found && found.sheet_id === s1 && found.user_id === uid)
assert.deepEqual(linkOptions(found!), { mode: 'replace' })
assert.equal(useFileLink(found!), true)
assert.equal(useFileLink(found!), false, 'a second use is refused')
assert.equal(findFileLink(up.token, 'upload'), null)
// Handed back (its sheet was busy, nothing imported), it works again.
assert.equal(releaseFileLink(found!), true)
assert.ok(findFileLink(up.token, 'upload'))
assert.equal(findFileLink(crypto.randomBytes(32).toString('hex'), 'upload'), null, 'an unknown link finds nothing')

// Expired: refused, and there is nothing to hand back.
const late = make(tok, s1, 'download')
const lateLink = findFileLink(late.token, 'download')!
useFileLink(lateLink)
db.prepare("UPDATE file_links SET expires_at = datetime('now', '-1 second') WHERE token_hash = ?").run(sha(late.token))
assert.equal(findFileLink(late.token, 'download'), null)
assert.equal(releaseFileLink(lateLink), false)

// The token that made it revoked, or expired: refused.
const revoked = accessToken('revoked'), lapsed = accessToken('lapsed')
const byRevoked = make(revoked, s1, 'download'), byLapsed = make(lapsed, s1, 'download')
assert.ok(findFileLink(byRevoked.token, 'download') && findFileLink(byLapsed.token, 'download'))
db.prepare("UPDATE access_tokens SET revoked_at = datetime('now') WHERE id = ?").run(revoked)
db.prepare("UPDATE access_tokens SET expires_at = datetime('now', '-1 second') WHERE id = ?").run(lapsed)
assert.equal(findFileLink(byRevoked.token, 'download'), null)
assert.equal(findFileLink(byLapsed.token, 'download'), null)

// A deleted sheet takes its links with it.
const s2 = sheet()
const gone = make(tok, s2, 'download')
db.prepare('DELETE FROM sheets WHERE id = ?').run(s2)
assert.equal(count(gone.token), 0)

// Making a link clears out expired ones, but keeps a used one until it
// expires: an upload still in progress may hand it back.
const inFlight = make(tok, s1, 'upload')
const inFlightLink = findFileLink(inFlight.token, 'upload')!
useFileLink(inFlightLink)
make(tok, s1, 'upload')
assert.equal(count(late.token), 0)
assert.equal(count(inFlight.token), 1)
assert.equal(releaseFileLink(inFlightLink), true)
assert.ok(findFileLink(inFlight.token, 'upload'))
assert.deepEqual(linkOptions({ id: '', user_id: '', sheet_id: '', options: 'not json' }), {})

// Where links point: PUBLIC_URL when set, else the scheme and host the request came in on.
const req = (host: string | undefined, headers: Record<string, string> = {}, secure = false) => ({
  secure, headers: { host, ...headers },
  get: (h: string) => ({ host, ...headers } as Record<string, string | undefined>)[h.toLowerCase()],
}) as never
const saved = process.env.PUBLIC_URL
process.env.PUBLIC_URL = 'https://cubex.example.com/'
assert.equal(linkBase(req('evil.example')), 'https://cubex.example.com')
delete process.env.PUBLIC_URL
assert.equal(linkBase(req('cubex.example.com', { 'x-forwarded-proto': 'https' })), 'https://cubex.example.com')
assert.equal(linkBase(req('192.168.1.10:3002')), 'http://192.168.1.10:3002')
assert.equal(linkBase(req('[::1]:3002', {}, true)), 'https://[::1]:3002')
assert.match(linkBase(req('bad host/x')), /^http:\/\/localhost:\d+$/)
assert.match(linkBase(req(undefined)), /^http:\/\/localhost:\d+$/)
if (saved !== undefined) process.env.PUBLIC_URL = saved
assert.equal(fileLinkUrl('https://c.example', 'upload', 'ab'), 'https://c.example/api/files/upload/ab')

// The upload cap: a body within it lands whole and owner-only; past it, refused.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubex-upload-'))
const whole = path.join(dir, 'whole')
assert.equal(await receive(Readable.from([Buffer.from('a,b\n'), Buffer.from('1,2\n')]), whole, 8), null)
assert.equal(fs.readFileSync(whole, 'utf8'), 'a,b\n1,2\n')
assert.equal(fs.statSync(whole).mode & 0o777, 0o600)
const over = await receive(Readable.from([Buffer.from('a,b\n'), Buffer.from('1,2\n')]), path.join(dir, 'over'), 7)
assert.equal(over?.fail, 'too_big')
fs.rmSync(dir, { recursive: true, force: true })

// A replace with a file that has no header row would empty the sheet: refused,
// and the upload's copy is removed either way.
prepareUploadDir()
const s3 = sheet()
const blank = await importUploadedCsv(Readable.from([Buffer.from('\n')]), s3, uid, true)
assert.ok('fail' in blank && blank.fail === 'parse' && /no header row/.test(blank.error), JSON.stringify(blank))
const appended = await importUploadedCsv(Readable.from([Buffer.from('a,b\n1,2\n')]), s3, uid, false)
assert.ok('ok' in appended && appended.ok.rowsImported === 1, JSON.stringify(appended))
assert.deepEqual(fs.readdirSync(UPLOAD_DIR), [])

// Link tokens never reach a log whole, and adding that pattern didn't stop the
// others from applying (redactSecrets applies them by position).
const hex = 'ab12'.repeat(16)
assert.equal(redactSecrets(`PUT https://c.example/api/files/upload/${hex} failed`),
  'PUT https://c.example/api/files/upload/[REDACTED] failed')
assert.equal(redactSecrets(`GET /api/files/download/${hex}`), 'GET /api/files/download/[REDACTED]')
assert.equal(redactSecrets(`cubex_pat_${'0'.repeat(64)} leaked`), '[REDACTED] leaked')
assert.equal(redactSecrets(`POST /api/webhooks/${'A'.repeat(43)}`), 'POST /api/webhooks/[REDACTED]')

console.log('All file-links assertions passed.')
