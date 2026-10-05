import fs from 'fs';
import path from 'path';
import { db } from '../lib/db';
import { DB_PATH } from '../lib/db-path';

export function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Look for migrations next to this file (dev: src/db/migrations, prod: dist/db/migrations).
  // Fall back to src/db/migrations if running compiled code without copied .sql files.
  const candidates = [
    path.join(__dirname, 'migrations'),
    path.resolve(__dirname, '../../src/db/migrations'),
  ];
  const migrationsDir = candidates.find(p => fs.existsSync(p));
  if (!migrationsDir) {
    throw new Error(`Migrations directory not found. Tried: ${candidates.join(', ')}`);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name)
  );

  // A history naming migrations this build doesn't have means the database was
  // made by a different or newer build (e.g. the old multi-user Cubex, whose
  // migrations were squashed into 001_schema.sql). Applying ours on top would
  // fail halfway with a raw SQLite error, so stop with a clear one instead.
  const known = new Set(files);
  const foreign = [...applied].filter(name => !known.has(name));
  if (foreign.length > 0) {
    console.error(
      `❌ ${DB_PATH} was created by a different or newer build of Cubex ` +
      `(unknown migrations: ${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}).\n` +
      '   Point DB_PATH at a new file to start fresh. To bring data over, export each sheet as CSV\n' +
      '   from the build that made this database and import it here.',
    );
    process.exit(1);
  }

  const insertMigration = db.prepare('INSERT INTO _migrations (name) VALUES (?)');

  let appliedAny = false;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // A file starting with this marker rebuilds a table, which SQLite only allows
    // safely with foreign keys off. The pragma is a no-op inside a transaction,
    // so it is switched around it, and the keys are checked before the commit.
    const keysOff = sql.startsWith('-- cube:foreign-keys-off');
    if (keysOff) db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(sql);
        if (keysOff && (db.pragma('foreign_key_check') as unknown[]).length > 0) {
          throw new Error(`${file} left rows that break a foreign key; nothing was changed.`);
        }
        insertMigration.run(file);
      });
      tx();
    } finally {
      if (keysOff) db.pragma('foreign_keys = ON');
    }
    appliedAny = true;
    console.log(`✅ Migration applied: ${file}`);
  }
  // db.ts runs `optimize` before the tables exist on a fresh install, and new
  // indexes have no statistics yet: refresh them now rather than at the next boot.
  if (appliedAny) db.pragma('optimize = 0x10002');
}
