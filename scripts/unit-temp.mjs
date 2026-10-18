// Runs a command with TMPDIR pointing at a fresh folder and deletes that folder afterwards, so the
// test databases the unit tests make (mktemp -d, os.tmpdir()) never pile up: one run makes ~60 and
// nothing removed them, which filled a disk with thousands of folders.
// Usage: node scripts/unit-temp.mjs <command> [args...]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'cubex-unit-';
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: node scripts/unit-temp.mjs <command> [args...]');
  process.exit(2);
}

// Not realpath'd: tsx puts a socket in here and macOS caps socket paths near 104 characters.
const base = path.resolve(os.tmpdir());
const dir = mkdtempSync(path.join(base, PREFIX));
// Ctrl+C reaches the child too; staying alive here lets the clean-up below still run.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});

let status = 1;
try {
  const run = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, TMPDIR: dir } });
  if (run.error) console.error(run.error.message);
  status = run.status ?? 1;
} finally {
  // Only ever the folder made above.
  if (path.dirname(dir) === base && path.basename(dir).startsWith(PREFIX)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(status);
