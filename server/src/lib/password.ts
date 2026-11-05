import crypto from 'crypto';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from './constants';

// argon2id with OWASP's "standard application" parameters (64 MiB, 3 passes):
// roughly 250-500 ms per hash on commodity hardware. Node's own crypto.argon2
// (24.7+) computes it on libuv's thread pool, so no native module is needed.
// Hashes are the standard string the argon2 npm package wrote before the
// switch, so passwords set with it keep working (tests/unit/password.test.ts):
//   $argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>   (base64 without padding)
const ALGORITHM = 'argon2id';
const VERSION = 0x13; // 19: the only Argon2 version Node computes
const COST: Cost = { m: 65536, t: 3, p: 1 }; // memory in KiB, passes, lanes
const SALT_BYTES = 16;
const HASH_BYTES = 32;

type Variant = 'argon2d' | 'argon2i' | 'argon2id';
interface Cost { m: number; t: number; p: number }
interface StoredHash {
  variant: Variant;
  version: number | null;
  cost: Cost;
  data: Buffer;
  salt: Buffer;
  hash: Buffer;
}

const VARIANTS: ReadonlySet<string> = new Set(['argon2d', 'argon2i', 'argon2id']);
const BASE64 = /^[A-Za-z0-9+/]+$/;
const DECIMAL = /^(0|[1-9]\d{0,9})$/;

// A message when this Node can't hash passwords, else null. crypto.argon2
// arrived in 24.7.0, and a Node built against an OpenSSL older than 3.2 has the
// function but throws on every call, so a tiny hash (under a millisecond)
// decides, once. The server checks at boot, before migrations run, and the
// reset-password CLI before it asks for anything.
let unavailable: string | null | undefined;
export function passwordHashingUnavailable(): string | null {
  if (unavailable === undefined) unavailable = argon2Problem();
  return unavailable;
}

type Argon2Sync = (algorithm: Variant, parameters: crypto.Argon2Parameters) => Buffer;
export function argon2Problem(node: { argon2Sync?: Argon2Sync } = crypto): string | null {
  const version = `Node.js ${process.versions.node}`;
  if (typeof node.argon2Sync !== 'function') {
    return `Cubex needs Node.js 24.7 or newer to hash passwords, and this is ${version}.`;
  }
  try {
    node.argon2Sync('argon2id', { message: '', nonce: Buffer.alloc(8), memory: 8, passes: 1, parallelism: 1,
      tagLength: 4 });
    return null;
  } catch {
    return `This ${version} can't hash passwords with argon2: it's built with OpenSSL ${process.versions.openssl}, `
      + 'and Cubex needs OpenSSL 3.2 or newer (the official Node.js 24 builds have it).';
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await derive(ALGORITHM, password, salt, COST, HASH_BYTES);
  const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
  return `$${ALGORITHM}$v=${VERSION}$m=${COST.m},t=${COST.t},p=${COST.p}$${b64(salt)}$${b64(hash)}`;
}

// Recomputes with the stored hash's own variant and cost, so older parameters
// (the package's default p=4, say) still verify; needsRehash then upgrades them.
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const stored = parseHash(hash);
  if (!stored || stored.version !== VERSION) return false;
  try {
    const computed = await derive(stored.variant, password, stored.salt, stored.cost, stored.hash.length, stored.data);
    return computed.length === stored.hash.length && crypto.timingSafeEqual(computed, stored.hash);
  } catch {
    // A stored hash Node refuses is just a no. A Node that can't hash at all is
    // worth a line in the log: every sign-in would fail the same way.
    const unusable = passwordHashingUnavailable();
    if (unusable) console.error(`❌ ${unusable}`);
    return false;
  }
}

// True when the stored hash was made with a different version or cost than
// COST, so a successful login can transparently upgrade it. Like the argon2
// package's needsRehash: the variant isn't compared, and a malformed hash is true.
export function needsRehash(hash: string): boolean {
  const stored = parseHash(hash);
  if (!stored) return true;
  const { m, t, p } = stored.cost;
  return stored.version !== VERSION || m !== COST.m || t !== COST.t || p !== COST.p;
}

function derive(
  variant: Variant, password: string, salt: Buffer, cost: Cost, length: number, data?: Buffer,
): Promise<Buffer> {
  const unavailable = passwordHashingUnavailable();
  if (unavailable) return Promise.reject(new Error(unavailable));
  return new Promise((resolve, reject) => {
    crypto.argon2(variant, {
      message: password,
      nonce: salt,
      memory: cost.m,
      passes: cost.t,
      parallelism: cost.p,
      tagLength: length,
      ...(data && data.length > 0 ? { associatedData: data } : {}),
    }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// The stored string's parts, or null when it isn't an argon2 hash this module
// can read. Optional `data=` (associated data) is read as the package did;
// other parameter names are ignored, as they were there.
function parseHash(text: unknown): StoredHash | null {
  if (typeof text !== 'string' || !text.startsWith('$')) return null;
  const parts = text.slice(1).split('$');
  const variant = parts.shift() ?? '';
  if (!VARIANTS.has(variant)) return null;
  let version: number | null = null;
  const v = /^v=(\d{1,10})$/.exec(parts[0] ?? '');
  if (v) {
    version = Number(v[1]);
    parts.shift();
  }
  if (parts.length !== 3) return null;
  const [paramText, saltText, hashText] = parts;
  if (!BASE64.test(saltText) || !BASE64.test(hashText)) return null;
  const params = new Map<string, string>();
  for (const pair of paramText.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    params.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const [m, t, p] = ['m', 't', 'p'].map(name => params.get(name) ?? '');
  if (![m, t, p].every(n => DECIMAL.test(n))) return null;
  const data = params.get('data') ?? '';
  if (data !== '' && !BASE64.test(data)) return null;
  return {
    variant: variant as Variant,
    version,
    cost: { m: Number(m), t: Number(t), p: Number(p) },
    data: Buffer.from(data, 'base64'),
    salt: Buffer.from(saltText, 'base64'),
    hash: Buffer.from(hashText, 'base64'),
  };
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
