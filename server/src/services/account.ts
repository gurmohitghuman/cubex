// The single account's creation, shared by first-run setup (POST
// /api/auth/setup) and the INITIAL_PASSWORD boot path (index.ts), so both go
// through the same check-and-insert.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { hashPassword, newPasswordError } from '../lib/password';

export function accountExists(): boolean {
  return db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined;
}

// Create the account from an already-computed hash (hashing is slow and async,
// so callers do it first). The existence check and the insert run in ONE
// synchronous transaction, so two racing callers can't both create an account.
// Returns the new user id, or null when an account already exists.
export function createAccount(passwordHash: string): string | null {
  const id = uuidv4();
  return db.transaction(() => {
    if (accountExists()) return null;
    db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(id, passwordHash);
    db.prepare('INSERT INTO settings (id, user_id) VALUES (?, ?)').run(uuidv4(), id);
    return id;
  })();
}

// INITIAL_PASSWORD creates the account at boot, before the server accepts any
// request, instead of letting the first visitor choose the password. It's for
// installs that are public from the moment they start (Coolify and other
// hosting panels), where the first visitor might not be you. Only a fresh
// install is affected: once the account exists the value is ignored, and the
// password is changed in Settings or with `npm run reset-password`. A value
// that breaks the password rules throws, so the boot stops instead of quietly
// leaving first-run setup open.
export async function createAccountFromEnv(
  password: string | undefined = process.env.INITIAL_PASSWORD,
): Promise<'unset' | 'exists' | 'created'> {
  if (!password) return 'unset';
  if (accountExists()) return 'exists';
  const invalid = newPasswordError(password);
  if (invalid) throw new Error(`INITIAL_PASSWORD can't be used: ${invalid}.`);
  return createAccount(await hashPassword(password)) ? 'created' : 'exists';
}
