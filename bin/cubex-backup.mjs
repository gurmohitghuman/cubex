// The copy of your data an update makes before the new version can change it
// (its migrations only go forward, and an older version refuses a database a
// newer one migrated), and putting it back: when the new version doesn't start
// (install.sh, install.ps1), or by hand (cubex rollback). Made while Cubex is
// stopped: the database and jobs.db, each with the -wal, -shm or -journal file
// SQLite may have left beside it. One copy is kept, in <data>/backups/before-update.
//
// Putting it back moves files, never copies them (no disk space needed): the
// data it replaces goes to a new <data>/backups/replaced-<time> folder (never
// deleted here), then the copy takes its place and is used up. A marker in the
// copy says how far that got, so running it again after a failure goes on from
// there instead of starting over.
//
//   node cubex-backup.mjs save <db> <jobs.db> <version>   (exit 2: not enough disk space; 4: no database yet)
//   node cubex-backup.mjs restore <db> <jobs.db>          (exit 3: no copy)
//   node cubex-backup.mjs info <db>                       prints the copy's {version, at}; exit 3: no copy
import fs from 'node:fs';
import path from 'node:path';

const [cmd, db, jobs, version] = process.argv.slice(2);
const SUFFIXES = ['', '-wal', '-shm', '-journal'];
const HEADROOM = 50 * 1024 * 1024;
const INFO = 'backup.json', MARKER = 'restoring.json';

const fail = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code); };
const backups = () => path.join(path.dirname(db), 'backups');
const slot = name => path.join(backups(), name);
const liveFiles = () => [db, jobs].flatMap(f => SUFFIXES.map(s => f + s));
const mb = bytes => Math.ceil(bytes / 1024 / 1024).toLocaleString('en-US');

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
}
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

// Windows: a file a process that just stopped (or an antivirus scan) still
// holds refuses a rename for a moment.
function retrying(fn) {
  for (let tries = 0; ; tries++) {
    try { return fn(); } catch (error) {
      const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
      if (process.platform !== 'win32' || tries >= 40 || !busy) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

// A rename, or a copy when the two are on different disks (a JOBS_DB_PATH elsewhere).
function moveFile(from, to) {
  try { retrying(() => fs.renameSync(from, to)); } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o600);
    fs.rmSync(from, { force: true });
  }
}

function save() {
  const live = liveFiles().filter(f => fs.existsSync(f));
  if (!live.includes(db)) fail('There is no database yet: nothing to keep.', 4);
  const dir = slot('before-update'), tmp = `${dir}.tmp`, old = `${dir}.old`;
  fs.mkdirSync(backups(), { recursive: true, mode: 0o700 });
  fs.rmSync(tmp, { recursive: true, force: true });
  const need = live.reduce((n, f) => n + fs.statSync(f).size, 0);
  const free = freeBytes(backups());
  if (free < need + HEADROOM) {
    fail('Not enough free disk space to keep a copy of your data before the update: it needs '
      + `${mb(need + HEADROOM)} MB and ${mb(free)} MB are free. Free some space, then run the update again.`, 2);
  }
  // A copy cut short never replaces a whole one, and leaves nothing behind.
  try {
    fs.mkdirSync(tmp, { mode: 0o700 });
    for (const f of live) {
      const to = path.join(tmp, path.basename(f));
      fs.copyFileSync(f, to);
      fs.chmodSync(to, 0o600);
    }
    writeJson(path.join(tmp, INFO), { version: version || 'unknown', at: new Date().toISOString() });
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(dir)) retrying(() => fs.renameSync(dir, old));
    try { retrying(() => fs.renameSync(tmp, dir)); } catch (error) {
      if (fs.existsSync(old) && !fs.existsSync(dir)) fs.renameSync(old, dir);
      throw error;
    }
    fs.rmSync(old, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    fail(`Keeping a copy of your data failed: ${error?.message ?? error}`);
  }
}

function restore() {
  const from = slot('before-update');
  if (!readJson(path.join(from, INFO))) fail('There is no copy of your data from before an update.', 3);
  const markerFile = path.join(from, MARKER);
  let marker = readJson(markerFile);
  if (!marker) {
    marker = { aside: `replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`, stage: 'aside' };
    fs.mkdirSync(slot(marker.aside), { recursive: true, mode: 0o700 });
    writeJson(path.join(slot(marker.aside), INFO), { at: new Date().toISOString() });
    writeJson(markerFile, marker);
  }
  if (marker.stage === 'aside') {
    // The data it replaces is kept aside, not deleted: a rollback by mistake can be undone by hand.
    for (const f of liveFiles()) if (fs.existsSync(f)) moveFile(f, path.join(slot(marker.aside), path.basename(f)));
    marker.stage = 'in';
    writeJson(markerFile, marker);
  }
  for (const f of liveFiles()) {
    const copy = path.join(from, path.basename(f));
    if (fs.existsSync(copy)) moveFile(copy, f);
  }
  fs.rmSync(from, { recursive: true, force: true });
  process.stdout.write(`${slot(marker.aside)}\n`);
}

if (!db || (cmd !== 'info' && !jobs)) fail('Usage: cubex-backup.mjs save|restore <db> <jobs.db> [version] | info <db>');
if (jobs && path.basename(db) === path.basename(jobs)) fail('The database and jobs.db need different file names.');

if (cmd === 'save') save();
else if (cmd === 'restore') {
  try { restore(); } catch (error) {
    fail(`Putting your data back stopped partway (${error?.message ?? error}). Nothing is lost: everything is in `
      + `${backups()}. Run the same command again to finish.`);
  }
} else if (cmd === 'info') {
  const info = readJson(path.join(slot('before-update'), INFO));
  if (!info) fail('There is no copy of your data from before an update.', 3);
  process.stdout.write(`${JSON.stringify(info)}\n`);
} else {
  fail(`Unknown command: ${cmd}`);
}
