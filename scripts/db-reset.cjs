#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Wipes the local dev SQLite database. Refuses to run if any of the
// production-safety conditions trip — historically `rm -f cubex.db*` got
// shell-pasted during smoke tests and lost real data, and on a live server
// the same command would wipe all of your data.
//
// Refuses to run when:
//   1. NODE_ENV === 'production'
//   2. DB_PATH points outside the project's server/data/ tree
//   3. The target path doesn't end in cubex.db
//   4. NPM_RUN_DB_RESET_CONFIRM != "1" (forces an explicit opt-in)
//
// Usage:
//   NPM_RUN_DB_RESET_CONFIRM=1 npm run db:reset

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const defaultDb = path.join(projectRoot, 'server/data/cubex.db');
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : defaultDb;

function die(msg) {
  console.error('❌ db:reset refused — ' + msg);
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  die('NODE_ENV=production. Never run this against a production DB.');
}

if (process.env.NPM_RUN_DB_RESET_CONFIRM !== '1') {
  die(
    'safety guard. To proceed, run:\n' +
    '   NPM_RUN_DB_RESET_CONFIRM=1 npm run db:reset\n' +
    '   (this wipes ' + dbPath + ' and its WAL/SHM files)'
  );
}

if (!dbPath.startsWith(projectRoot)) {
  die(`DB_PATH (${dbPath}) is outside the project root. Refusing to delete.`);
}
if (path.basename(dbPath) !== 'cubex.db') {
  die(`DB_PATH (${dbPath}) doesn't look like a Cubex DB (basename must be cubex.db).`);
}

const files = [dbPath, dbPath + '-wal', dbPath + '-shm'];
let removed = 0;
for (const f of files) {
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    removed++;
    console.log('  rm ' + f);
  }
}
console.log(`✓ db:reset complete (${removed} file${removed === 1 ? '' : 's'} removed)`);
