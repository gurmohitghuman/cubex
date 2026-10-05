import argon2 from 'argon2';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from './constants';

// argon2id with OWASP's "standard application" parameters (64 MiB, 3 passes):
// roughly 250-500 ms per hash on commodity hardware.
const ARGON_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// True when the stored hash was made with different parameters than
// ARGON_OPTS, so a successful login can transparently upgrade it.
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON_OPTS);
  } catch {
    return true;
  }
}

// Validation for a NEW password (first-run setup, change password, CLI reset).
// Returns an error message, or null when the password is acceptable.
export function newPasswordError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer`;
  }
  return null;
}
