// Open tabs learn that Cubex was updated: the server names the app build it
// serves (server/src/lib/build-id.ts: the entry script its index.html loads,
// read again when the file changes), and a tab whose own entry script is
// another says so, once (client/src/lib/build-watch.ts). No server.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import buildMod from '../../server/src/lib/build-id'
import constMod from '../../server/src/lib/constants'
import { buildOfScript, resetBuildWatch, updatedSinceLoad } from '../../client/src/lib/build-watch'
const { currentBuildId, entryOf, serveBuildFrom } = buildMod as typeof import('../../server/src/lib/build-id')
const { BUILD_ID_RECHECK_MS } = constMod as typeof import('../../server/src/lib/constants')

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}
const page = (entry: string) => `<head><script type="module" crossorigin src="/assets/${entry}.js"></script>`
  + '<link rel="modulepreload" crossorigin href="/assets/react-DxpwdLvS.js"></head>'

check('the entry script of an index.html', entryOf(page('index-CCFt8I62')) === 'index-CCFt8I62')
check('no entry script, no build', entryOf('<script src="/src/main.tsx"></script>') === null)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-'))
const index = path.join(dir, 'index.html')
check('no client served: no build id', currentBuildId() === null)
fs.writeFileSync(index, page('index-AAAA1111'))
serveBuildFrom(index)
const t0 = Date.now()
check('the served build', currentBuildId(t0) === 'index-AAAA1111', currentBuildId(t0))
fs.writeFileSync(index, page('index-BBBB2222'))
fs.utimesSync(index, new Date(), new Date(Date.now() + 5000))
check('a new build on disk is looked at again within the recheck time',
  currentBuildId(t0 + 1) === 'index-AAAA1111' && currentBuildId(t0 + BUILD_ID_RECHECK_MS + 1) === 'index-BBBB2222')
fs.rmSync(index)
check('an unreadable index.html: no id rather than a wrong one', currentBuildId(t0 + 3 * BUILD_ID_RECHECK_MS) === null)
fs.rmSync(dir, { recursive: true, force: true })

check('a tab\'s build from its entry script URL', buildOfScript('/assets/index-CCFt8I62.js') === 'index-CCFt8I62'
  && buildOfScript('https://cubex.example/assets/index-CCFt8I62.js') === 'index-CCFt8I62')
check('in development (no built entry) a tab has no build', buildOfScript('/src/main.tsx') === null
  && buildOfScript(null) === null)
resetBuildWatch()
const own = 'index-CCFt8I62'
check('answers naming no build, or this tab\'s, say nothing',
  !updatedSinceLoad(undefined, own) && !updatedSinceLoad('', own) && !updatedSinceLoad(own, own))
check('a tab without a build says nothing', !updatedSinceLoad('index-ZZZZ', null))
check('another build: updated', updatedSinceLoad('index-DDDD3333', own))
check('said once', !updatedSinceLoad('index-DDDD3333', own) && !updatedSinceLoad('index-EEEE', own))

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
