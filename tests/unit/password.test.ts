// Passwords are hashed with Node's own crypto.argon2 (Node 24.7+), not the argon2 npm package. Pins: hashes the
// package (0.44.0) made before the switch still verify, a wrong password fails, and needsRehash answers what the
// package did (the app's p=1, the package's default p=4, an older cost, argon2i, a password beyond ASCII, argon2d
// with p=2 and a short hash and salt, associated data, a 64-byte hash); a new hash is the same standard string,
// verifies, and gets a fresh salt each time; a malformed or tampered hash fails without throwing (and a malformed one
// needs a rehash); a Node without crypto.argon2, or whose argon2 throws (OpenSSL before 3.2), is named as such.
import assert from 'node:assert/strict'
import passwordMod from '../../server/src/lib/password'
const { hashPassword, verifyPassword, needsRehash, passwordHashingUnavailable, argon2Problem } =
  passwordMod as typeof import('../../server/src/lib/password')

// Made with argon2 0.44.0 (the first five on Node 22, before it left package.json; the last three with the same
// package on Node 24); needsRehash is what that package answered.
const BEFORE = [
  { label: 'app p=1', password: 'correct horse battery staple', needsRehash: false,
    hash: '$argon2id$v=19$m=65536,t=3,p=1$hiVlTwzVz9OoHBfoI60sAw$3JSJ1FmzHRDPjH5Z9BpV2AXhlyQt1YhWv9xZwtXDHQU' },
  { label: 'package default p=4', password: 'correct horse battery staple', needsRehash: true,
    hash: '$argon2id$v=19$m=65536,t=3,p=4$DMrjyxfefpViFt8GtVHNZg$A5Q+8uFEOvizbV7xP+bta/V352ocnqUo33ETB3YauRY' },
  { label: 'app p=1, unicode', password: 'Grüße, Cubex! 🔑 пароль', needsRehash: false,
    hash: '$argon2id$v=19$m=65536,t=3,p=1$3mIJ5BGbuUUeMIvWZrOKNg$TT1GnA5kMFG1rS/SyohqKCYrxpvA6eqkqt2MSoUIdN4' },
  { label: 'older params m=19456 t=2 p=1', password: 'an older-parameters password', needsRehash: true,
    hash: '$argon2id$v=19$m=19456,t=2,p=1$5hxinkEbonZni1bWMFsUSQ$tIUicBRKrffG5FKD3x8lIGlhzKS0p5Mf0NOAsTJ7HHw' },
  { label: 'argon2i', password: 'an argon2i password', needsRehash: false,
    hash: '$argon2i$v=19$m=65536,t=3,p=1$8KhpDGQPBM/0T++tnR1EjQ$oOhwCRXQM+cOsLTHQolnChYzuXo4wl+N+Iezf0BCvTw' },
  { label: 'argon2d, p=2, 16-byte hash, 8-byte salt', password: 'an argon2d password', needsRehash: true,
    hash: '$argon2d$v=19$m=65536,t=3,p=2$UjZ60rI5CAc$r5fGKZob/u0BfGESoXnQOA' },
  { label: 'associated data', password: 'a password with data', needsRehash: false,
    hash: '$argon2id$v=19$m=65536,t=3,p=1,data=Y3ViZXgtYXNzb2NpYXRlZA$k+FDQQT8HLOyuw3U/ZN8VA$'
      + 'ydPMog+dn+HXtDnEmggdvn4IHxG0+7925jYX8/qaimM' },
  { label: '64-byte hash, 32-byte salt', password: 'a long-hash password', needsRehash: false,
    hash: '$argon2id$v=19$m=65536,t=3,p=1$1i10MnxQRoN4JINpOpMng7X0jSJGQYetmJfspwnVEn4$'
      + 'FpdFHFz65/YnUq3ULuZaVTywPrF4LP8yRl4sSyHmduhgjqJIbD5pVjyDlX0xJ0vBaRguSHzaXl9iAlvyiw5k2g' },
]
const NEW_HASH = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/

async function main(): Promise<void> {
  assert.equal(passwordHashingUnavailable(), null)
  assert.equal(argon2Problem(), null)
  assert.match(argon2Problem({}) ?? '', /needs Node\.js 24\.7 or newer/)
  const throws = () => { throw Object.assign(new Error('not supported'), { code: 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED' }) }
  assert.match(argon2Problem({ argon2Sync: throws }) ?? '', /OpenSSL .* needs OpenSSL 3\.2 or newer/)
  console.log('ok   this Node hashes; no crypto.argon2, or one that throws, is named as such')

  for (const f of BEFORE) {
    assert.equal(await verifyPassword(f.password, f.hash), true, f.label)
    assert.equal(await verifyPassword(f.password + 'x', f.hash), false, f.label)
    assert.equal(await verifyPassword('', f.hash), false, f.label)
    assert.equal(needsRehash(f.hash), f.needsRehash, f.label)
    console.log(`ok   made by argon2 0.44.0 (${f.label}): verifies, wrong fails, needsRehash ${f.needsRehash}`)
  }

  const [a, b] = [await hashPassword(BEFORE[0].password), await hashPassword(BEFORE[0].password)]
  assert.match(a, NEW_HASH)
  assert.notEqual(a, b)
  assert.equal(await verifyPassword(BEFORE[0].password, a), true)
  assert.equal(await verifyPassword(BEFORE[0].password, b), true)
  assert.equal(await verifyPassword(BEFORE[0].password + 'x', a), false)
  assert.equal(needsRehash(a), false)
  const other = await hashPassword(BEFORE[2].password)
  assert.equal(await verifyPassword(BEFORE[2].password, other), true)
  assert.equal(await verifyPassword(BEFORE[2].password.normalize('NFD'), other), false)
  console.log('ok   new hash: standard string, fresh salt, verifies, wrong fails, no rehash')

  const good = BEFORE[0].hash
  const [, , , , salt, hash] = good.split('$')
  // A character inside the hash (the last one's low bits are unused, so changing it may change no byte).
  const at = good.length - 10
  const tampered = good.slice(0, at) + (good[at] === 'A' ? 'B' : 'A') + good.slice(at + 1)
  assert.equal(await verifyPassword(BEFORE[0].password, tampered), false)
  assert.equal(needsRehash(tampered), false)
  const malformed = [
    '', 'not a hash', '$argon2id$', `${good}$more`, good.replace('$argon2id$', '$scrypt$'),
    good.replace('$v=19', ''), good.replace('v=19', 'v=16'), good.replace('m=65536', 'm=lots'),
    good.replace(',p=1', ''), good.replace('p=1', 'p=0'), good.replace(`$${hash}`, ''), good.replace(salt, '!!!!'),
  ]
  for (const bad of malformed) {
    assert.equal(await verifyPassword(BEFORE[0].password, bad), false, bad)
    assert.equal(needsRehash(bad), true, bad)
  }
  // Well-formed, but Node refuses a 4-byte salt, and a 4-byte hash can't match: no, without throwing.
  for (const unusable of [good.replace(salt, 'c2FsdA'), good.replace(hash, 'aGFzaA')]) {
    assert.equal(await verifyPassword(BEFORE[0].password, unusable), false, unusable)
  }
  assert.equal(await verifyPassword(BEFORE[0].password, undefined as unknown as string), false)
  console.log(`ok   tampered or unusable hashes fail; ${malformed.length} malformed ones fail without throwing `
    + 'and need a rehash')
}

main().then(
  () => console.log('\nAll password assertions passed.'),
  (err) => { console.error(err); process.exit(1) },
)
