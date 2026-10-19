// db:reset's path check (scripts/db-reset.cjs pathRefusal): only a cubex.db under
// <project>/server/data may be wiped. A folder beside the project whose name
// starts the same (../Cube-other) is outside; Windows paths compare without case.
// Pure: nothing is opened or deleted here.
import { createRequire } from 'module'
const requireHere = createRequire(import.meta.url)
const { pathRefusal } = requireHere('../../scripts/db-reset.cjs') as {
  pathRefusal: (dbPath: string, projectRoot: string, platform?: string) => string | null
}

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}
const allowed = (db: string, root: string, platform: string) => pathRefusal(db, root, platform) === null
const outside = (db: string, root: string, platform: string) => /is outside/.test(pathRefusal(db, root, platform) ?? '')

const root = '/home/me/Cube'
check('posix: the default DB', allowed(`${root}/server/data/cubex.db`, root, 'linux'))
check('posix: a cubex.db deeper in server/data', allowed(`${root}/server/data/dev/cubex.db`, root, 'linux'))
check('posix: a sibling folder with the same prefix',
  outside('/home/me/Cube-jsontree/server/data/cubex.db', root, 'linux'), pathRefusal(
    '/home/me/Cube-jsontree/server/data/cubex.db', root, 'linux'))
check('posix: elsewhere in the project', outside(`${root}/cubex.db`, root, 'linux'))
check('posix: server/data-old beside server/data', outside(`${root}/server/data-old/cubex.db`, root, 'linux'))
check('posix: the data folder itself', outside(`${root}/server/data`, root, 'linux'))
check('posix: case differs (a different folder on Linux)', outside(`${root}/Server/Data/cubex.db`, root, 'linux'))
check('posix: another name is refused', /basename must be cubex\.db/.test(
  pathRefusal(`${root}/server/data/jobs.db`, root, 'linux') ?? ''))

const win = 'C:\\Users\\me\\Cube'
check('win32: the default DB', allowed(`${win}\\server\\data\\cubex.db`, win, 'win32'))
check('win32: case differs', allowed('c:\\users\\ME\\cube\\SERVER\\Data\\cubex.db', win, 'win32'))
check('win32: a sibling folder with the same prefix',
  outside('C:\\Users\\me\\Cube-setupversions\\server\\data\\cubex.db', win, 'win32'))
check('win32: another drive', outside('D:\\Cube\\server\\data\\cubex.db', win, 'win32'))
check('win32: the project root', outside(`${win}\\cubex.db`, win, 'win32'))

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nAll db:reset path assertions passed.')
