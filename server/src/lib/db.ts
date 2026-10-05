import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import fs from 'fs';
import { DB_PATH as dbPath, DATA_DIR as dataDir } from './db-path';

if (!fs.existsSync(dataDir)) {
  // mode: 0o700 — rwx for owner only. Sibling files (cubex.db, jobs.db,
  // .jwt-secret, .encryption-key) inherit safer defaults when their parent
  // isn't world-readable.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}
// Tighten existing data-dir perms too — covers the case where the directory
// was already created at 0o755 by an earlier boot.
try { fs.chmodSync(dataDir, 0o700); } catch { /* dir might not be ours to chmod */ }

export const db: DatabaseType = new Database(dbPath);

// SQLite creates cubex.db with the process umask (typically 0o022 → file is
// 0o644 = world-readable). Force 0o600 so your data + encrypted API keys
// can't be read by any other local user. The -wal and -shm sibling files
// inherit umask 0o077 (set in index.ts) on first creation, but we also
// chmod existing ones here for installs that predate that change.
for (const ext of ['', '-wal', '-shm', '-journal']) {
  const p = `${dbPath}${ext}`;
  try {
    if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
  } catch (err) {
    console.warn(`⚠️  Could not chmod ${p} to 0o600:`, (err as Error).message);
  }
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
// --- Defensive PRAGMAs (per https://sqlite.org/security.html) ---
// trusted_schema=OFF: prevents a malicious sqlite_schema (introduced via SQL
// injection, a compromised migration, or restore from an untrusted dump)
// from defining views/triggers/index expressions that invoke arbitrary
// custom functions. The SQLite team explicitly recommends turning this off
// for every app that handles untrusted input (CSV imports, webhook payloads).
db.pragma('trusted_schema = OFF');
// cell_size_check=ON: extra sanity-check on b-tree pages as they're read
// from disk. Catches corruption at the page level before it spreads into
// caches and subsequent writes. Small perf cost; worth it for prod.
db.pragma('cell_size_check = ON');
// secure_delete=ON: zero out freed page contents on DELETE. Without this,
// a row that contained an API key or password hash lives on as recoverable
// bytes in the .db file until the page is reused. Adds a few percent to
// DELETE/UPDATE cost, but ensures deleted data is really gone.
db.pragma('secure_delete = ON');
// Wait up to 5s for a contended write lock instead of failing immediately
// with SQLITE_BUSY. Important now that worker threads (Sidequest jobs) can
// hold the writer slot while the API process is also writing — under load,
// a transient lock collision shouldn't bubble up as a 500 to the user.
db.pragma('busy_timeout = 5000');
// Page cache: keep ~64MB of pages in memory (negative means KB). Default is 2MB which is
// way too small for the cell-per-cell model where a 50k×100 sheet has 5M rows.
db.pragma('cache_size = -64000');
// Memory-mapped I/O: let SQLite read pages directly from the OS page cache without
// copying into the SQLite cache. 256MB is enough for typical Cubex DBs.
db.pragma('mmap_size = 268435456');
// Speeds up large multi-row writes (CSV imports especially). 4MB is a safe default.
db.pragma('temp_store = MEMORY');
// Cap the WAL at 64MB. Without this, a long-running reader (e.g. an AI run
// holding a snapshot for minutes) can starve the auto-checkpoint and the
// -wal file grows unbounded — there's a documented 20GB-WAL incident in the
// wild. journal_size_limit truncates the WAL back down at the next
// checkpoint after it exceeds the limit; it does NOT cap mid-transaction
// growth, so a single huge write can still exceed it briefly.
db.pragma('journal_size_limit = 67108864');
// Trigger an auto-checkpoint after ~2000 WAL pages (~8MB at 4KB pages),
// up from the SQLite default of 1000. Slightly less checkpoint chatter
// during burst writes (CSV import, AI run streaming) at the cost of a
// marginally larger WAL between checkpoints — well within the size limit.
db.pragma('wal_autocheckpoint = 2000');

// Seed the query planner's stats so the first few queries on a fresh
// connection don't pick a bad plan. Mask 0x10002 = "analyze any table that
// might benefit" without the slow full-scan modes. Cheap at boot.
// Recommended by the SQLite team for long-lived connections.
db.pragma('optimize = 0x10002');

// Run PRAGMA optimize on shutdown so the next boot inherits up-to-date
// stats reflecting whatever the user did this session. Single best-effort
// call; we never want shutdown to hang on this. Wired into both the
// graceful shutdown path (via server-lifecycle) AND beforeExit as a
// belt-and-suspenders for non-signal exits.
process.on('beforeExit', () => {
  try { db.pragma('optimize'); } catch { /* shutting down — best effort */ }
});

// Integrity check at boot — catches DB corruption from a partial write /
// disk error / bad fsync before we start serving requests on top of it.
// integrity_check(10) reports up to 10 problems then returns. Result rows
// are [{ integrity_check: 'ok' }] when clean, otherwise an array of error
// descriptions. We log loudly but don't crash — operator decides whether
// to restore from backup or accept the risk; crashing on every boot of a
// corrupt DB makes recovery harder.
try {
  const result = db.pragma('integrity_check(10)') as Array<{ integrity_check: string }>;
  const ok = Array.isArray(result) && result.every(r => r.integrity_check === 'ok');
  if (!ok) {
    console.error('🚨 SQLite integrity_check FAILED:', JSON.stringify(result));
  }
} catch (err) {
  console.error('⚠️  SQLite integrity_check threw:', (err as Error).message);
}

console.log(`📁 SQLite database: ${dbPath}`);
