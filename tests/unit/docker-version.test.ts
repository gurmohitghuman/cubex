// The build a Docker or Coolify image records (scripts/docker-version.mjs), on scratch repositories with no git
// command: a release tag on the commit gives "vX.Y.Z sha", the newest when several do, lightweight or annotated,
// loose or packed; another commit "main sha"; CUBEX_VERSION as it is; SOURCE_COMMIT without a .git; nothing with
// neither. What it writes reads back as that release (lib/cubex-version.ts runningFrom).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import versionMod from '../../server/src/lib/cubex-version'
const { runningFrom } = versionMod as typeof import('../../server/src/lib/cubex-version')
const { dockerVersion } = await import('../../scripts/docker-version.mjs') as {
  dockerVersion: (dir: string, env?: Record<string, string | undefined>) => string }

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), T = 'd'.repeat(40)
function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubex-dv-'))
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, '.git', f)), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git', f), text)
  }
  return dir
}
const none = {}

const tagged = repo({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${A}\n`, 'refs/tags/v0.8.43': `${A}\n` })
assert.equal(dockerVersion(tagged, none), 'v0.8.43 aaaaaaa')
assert.deepEqual(runningFrom(dockerVersion(tagged, none)), { build: 'v0.8.43 aaaaaaa', version: 'v0.8.43' })
console.log('ok   a loose release tag on the commit: that release, read back as it')

const packed = repo({ HEAD: `${B}\n`, 'packed-refs': `# pack-refs\n${C} refs/tags/v0.8.9\n^${B}\n${B} refs/tags/v0.8.10\n${B} refs/tags/nightly\n` })
assert.equal(dockerVersion(packed, none), 'v0.8.10 bbbbbbb')
console.log('ok   packed, annotated and lightweight tags on a detached HEAD: the newest release')

const branch = repo({ HEAD: 'ref: refs/heads/main\n', packed: '', 'packed-refs': `${C} refs/heads/main\n${T} refs/tags/v0.8.1\n` })
assert.equal(dockerVersion(branch, none), 'main ccccccc')
console.log('ok   a commit no release names: main and its commit')

assert.equal(dockerVersion(tagged, { CUBEX_VERSION: ' v9.9.9 mine ' }), 'v9.9.9 mine')
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cubex-dv-'))
assert.equal(dockerVersion(bare, { SOURCE_COMMIT: A }), 'main aaaaaaa')
assert.equal(dockerVersion(bare, none), '')
console.log('ok   CUBEX_VERSION as it is; SOURCE_COMMIT without a .git; nothing with neither')
console.log('docker-version: all assertions passed')
