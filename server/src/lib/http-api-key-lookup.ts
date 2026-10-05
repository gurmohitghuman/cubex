import { db } from './db';
import { decrypt } from './crypto';

// Resolve a saved API key value by name for the HTTP-enrichment template path.
//
// runId (optional): when set, the key row is fetched ONLY if that run's
// allow_secrets policy still permits it — as ONE atomic SQL statement joining
// api_keys to http_runs. This is what closes the resume-freeze TOCTOU: the
// worker runs in its own thread while a no-'secrets' resume commits
// `allow_secrets = 0` from the API thread, so a JS-level "capture the boolean
// then look up the key" has a gap between the two SELECTs where the freeze can
// land. Folding the policy into the SAME query the key comes from removes that
// gap — SQLite evaluates the statement atomically, so the key is returned iff
// the policy is permissive AT THE MOMENT OF THE LOOKUP. runId omitted (preview,
// AI-config assist) ⇒ plain lookup, policy enforced by the caller's boolean.
export function lookupApiKey(userId: string, name: string, runId?: string): string | null {
  const row = runId
    ? db.prepare(
        `SELECT k.key_value_encrypted FROM api_keys k
         WHERE k.user_id = ? AND k.name = ?
           AND EXISTS (SELECT 1 FROM http_runs r WHERE r.id = ? AND r.allow_secrets != 0)`,
      ).get(userId, name, runId) as { key_value_encrypted: string } | undefined
    : db.prepare(
        'SELECT key_value_encrypted FROM api_keys WHERE user_id = ? AND name = ?',
      ).get(userId, name) as { key_value_encrypted: string } | undefined;
  if (!row) return null;
  const decrypted = decrypt(row.key_value_encrypted);
  if (decrypted === null) {
    console.error(`API key "${name}" decrypt failed for user ${userId}; treating as missing.`);
  }
  return decrypted;
}
