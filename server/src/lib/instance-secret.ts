import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db-path';

// Secrets generated on first boot and kept next to the database, so a fresh
// install needs no configuration and restarts keep the same values. Back up the
// data directory as a whole: losing .encryption-key makes every saved API key
// unreadable. Callers check their env var first; an env value always wins.
//
// Creation is exclusive ('wx'). The main thread and Sidequest worker threads can
// race to create the same file on first boot, and two different encryption keys
// would leave whatever the losing key encrypted unreadable. Exactly one writer
// wins; everyone else reads the winner's value.

const SECRET_BYTES = 32;
// A loser can open the file between the winner's create and write, and see it
// empty. Retry the read briefly before giving up.
const READ_RETRIES = 50;
const READ_RETRY_MS = 10;

function readSecret(file: string): string | null {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The file exists: return its value once a (possibly concurrent) writer has
// filled it. Still empty after the retries means an earlier first write died
// (disk full, killed mid-write), so say exactly how to recover.
function readExisting(file: string): string {
  for (let i = 0; i < READ_RETRIES; i++) {
    const value = readSecret(file);
    if (value) return value;
    sleepSync(READ_RETRY_MS);
  }
  throw new Error(`${file} exists but is empty. Delete it and restart Cubex.`);
}

// `beforeCreate` runs only when the file is missing, before a new value is
// generated; it can throw to refuse (crypto.ts does when encrypted data exists).
export function loadOrCreateInstanceSecret(fileName: string, beforeCreate?: (file: string) => void): string {
  const file = path.join(DATA_DIR, fileName);
  const existing = readSecret(file);
  if (existing) return existing;
  if (fs.existsSync(file)) return readExisting(file);

  beforeCreate?.(file);
  const generated = crypto.randomBytes(SECRET_BYTES).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, generated, { mode: 0o600, flag: 'wx' });
    console.log(`🔑 Generated ${file}`);
    return generated;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readExisting(file);
    throw new Error(
      `Could not create ${file} (${(err as Error).message}). ` +
      'Make sure the data directory is writable.',
    );
  }
}
