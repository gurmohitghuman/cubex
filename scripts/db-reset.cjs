#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Wipes the local dev SQLite database. Refuses to run if any of the
// production-safety conditions trip — historically `rm -f cubex.db*` got
// shell-pasted during smoke tests and lost real data, and on a live server
// the same command would wipe all of your data.
//
// Refuses to run when:
//   1. NODE_ENV === 'production'
//   2. DB_PATH points outside the project's server/data/ tree (a folder beside
//      the project whose name starts the same, like ../Cube-other, is outside)
//   3. The target path doesn't end in cubex.db
//   4. NPM_RUN_DB_RESET_CONFIRM != "1" (forces an explicit opt-in)
// The path checks come before the opt-in, so a refused path is refused either way.
// pathRefusal is exported for tests/unit/db-reset-path.test.ts; running the
// file is what wipes.
//
// Usage:
//   NPM_RUN_DB_RESET_CONFIRM=1 npm run db:reset
//   (PowerShell: $env:NPM_RUN_DB_RESET_CONFIRM='1'; npm run db:reset; Remove-Item Env:NPM_RUN_DB_RESET_CONFIRM)

const fs = require('node:fs');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';
const CONFIRM_CMD = IS_WINDOWS
  ? "$env:NPM_RUN_DB_RESET_CONFIRM='1'; npm run db:reset; Remove-Item Env:NPM_RUN_DB_RESET_CONFIRM\n" +
    '   (Git Bash: NPM_RUN_DB_RESET_CONFIRM=1 npm run db:reset)'
  : 'NPM_RUN_DB_RESET_CONFIRM=1 npm run db:reset';

// Why dbPath (absolute) may not be wiped, or null. Inside means under
// <projectRoot>/server/data by path.relative, not by a string prefix; Windows
// paths compare without case.
function pathRefusal(dbPath, projectRoot, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  const dataDir = p.join(projectRoot, 'server', 'data');
  const rel = p.relative(fold(dataDir), fold(dbPath));
  if (rel === '' || rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel)) {
    return `DB_PATH (${dbPath}) is outside ${dataDir}. Refusing to delete.`;
  }
  if (p.basename(dbPath) !== 'cubex.db') {
    return `DB_PATH (${dbPath}) doesn't look like a Cubex DB (basename must be cubex.db).`;
  }
  return null;
}

function die(msg) {
  console.error('❌ db:reset refused — ' + msg);
  process.exit(1);
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const defaultDb = path.join(projectRoot, 'server', 'data', 'cubex.db');
  const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : defaultDb;

  if (process.env.NODE_ENV === 'production') {
    die('NODE_ENV=production. Never run this against a production DB.');
  }
  const refused = pathRefusal(dbPath, projectRoot);
  if (refused) die(refused);
  if (process.env.NPM_RUN_DB_RESET_CONFIRM !== '1') {
    die(
      'safety guard. To proceed, run:\n' +
      '   ' + CONFIRM_CMD + '\n' +
      '   (this wipes ' + dbPath + ' and its WAL/SHM files)'
    );
  }
  wipe(dbPath);
}

function wipe(dbPath) {
  const files = [dbPath, dbPath + '-wal', dbPath + '-shm'];
  let removed = 0;
  for (const f of files) {
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch (err) {
        // Windows won't delete a database a running Cubex still has open.
        if (IS_WINDOWS && (err.code === 'EBUSY' || err.code === 'EPERM')) {
          die(`${f} is in use: stop Cubex first, then run this again.`);
        }
        throw err;
      }
      removed++;
      console.log('  rm ' + f);
    }
  }
  console.log(`✓ db:reset complete (${removed} file${removed === 1 ? '' : 's'} removed)`);
}

module.exports = { pathRefusal };
if (require.main === module) main();
