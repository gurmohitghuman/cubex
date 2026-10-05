// `npm run reset-password` — set a new password for the Cubex account from the
// server's shell. This is the only recovery path: Cubex has no email and no
// reset link. Signs out every browser (bumps session_epoch).
//
//   local:   npm run reset-password
//   Docker:  docker compose exec cubex npm run reset-password
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Same .env files as the server (server/.env, then the repo root). Everything
// that reads env at import time (db-path, db) is imported dynamically below, so
// it sees these values.
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // readline echoes each keystroke through _writeToOutput. The prompt is
    // written synchronously by question(), so muting right after it hides only
    // what the user types.
    const writer = rl as unknown as { _writeToOutput: (s: string) => void };
    let muted = false;
    writer._writeToOutput = (s: string) => { if (!muted) process.stdout.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('Run this in an interactive terminal (with Docker: docker compose exec cubex npm run reset-password).');
    process.exit(1);
  }
  const { DB_PATH } = await import('../lib/db-path');
  // Check before opening: opening a missing database would create an empty one.
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}. Set DB_PATH if Cubex keeps its data somewhere else.`);
    process.exit(1);
  }
  const { db } = await import('../lib/db');
  const { hashPassword, newPasswordError } = await import('../lib/password');

  const user = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined;
  if (!user) {
    console.log('No password has been set yet. Open Cubex in your browser to choose one.');
    return;
  }

  const password = await askHidden('New password: ');
  const invalid = newPasswordError(password);
  if (invalid) {
    console.error(invalid);
    process.exit(1);
  }
  if ((await askHidden('Type it again: ')) !== password) {
    console.error('The two passwords don\'t match. Nothing was changed.');
    process.exit(1);
  }

  db.prepare("UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1, updated_at = datetime('now') WHERE id = ?")
    .run(await hashPassword(password), user.id);
  console.log('Password updated. Every browser has been signed out.');
}

main().catch((err) => {
  console.error('reset-password failed:', err);
  process.exit(1);
});
